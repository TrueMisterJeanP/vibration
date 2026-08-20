package adminaccess

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"sort"
	"strings"
	"time"
)

const SettingKey = "admin_access_policy"

const (
	ModeAll       = "all"
	ModeLocal     = "local"
	ModeAllowlist = "allowlist"
	maxEntries    = 256
)

// Policy controls access to both the Administration and Gestion areas.
// AllowedIPs accepts individual IPv4/IPv6 addresses and CIDR networks.
type Policy struct {
	Mode       string   `json:"mode"`
	AllowedIPs []string `json:"allowed_ips"`
}

type Decision struct {
	Allowed  bool
	ClientIP netip.Addr
	Policy   Policy
}

type Controller struct {
	DB             *sql.DB
	TrustedProxies []netip.Prefix
}

func NewController(db *sql.DB, trustedProxies []netip.Prefix) *Controller {
	if len(trustedProxies) == 0 {
		trustedProxies = DefaultTrustedProxies()
	}
	return &Controller{DB: db, TrustedProxies: append([]netip.Prefix(nil), trustedProxies...)}
}

func DefaultPolicy() Policy {
	return Policy{Mode: ModeAll, AllowedIPs: []string{}}
}

func DefaultTrustedProxies() []netip.Prefix {
	return []netip.Prefix{
		netip.MustParsePrefix("127.0.0.0/8"),
		netip.MustParsePrefix("::1/128"),
	}
}

// ParseTrustedProxies validates the reverse proxies that may supply the real
// client address. Exact addresses are accepted as well as CIDR networks.
func ParseTrustedProxies(values []string) ([]netip.Prefix, error) {
	if len(values) == 0 {
		return DefaultTrustedProxies(), nil
	}
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefix, err := parseNetwork(value)
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy %q: %w", value, err)
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}

func Normalize(policy Policy) (Policy, error) {
	policy.Mode = strings.ToLower(strings.TrimSpace(policy.Mode))
	switch policy.Mode {
	case ModeAll, ModeLocal, ModeAllowlist:
	default:
		return Policy{}, errors.New("invalid administration access mode")
	}
	if len(policy.AllowedIPs) > maxEntries {
		return Policy{}, fmt.Errorf("too many allowed IP entries (maximum %d)", maxEntries)
	}
	seen := make(map[string]bool, len(policy.AllowedIPs))
	normalized := make([]string, 0, len(policy.AllowedIPs))
	for _, value := range policy.AllowedIPs {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		prefix, err := parseNetwork(value)
		if err != nil {
			return Policy{}, fmt.Errorf("invalid IP address or network %q", value)
		}
		canonical := prefix.String()
		if prefix.Bits() == prefix.Addr().BitLen() {
			canonical = prefix.Addr().String()
		}
		if !seen[canonical] {
			seen[canonical] = true
			normalized = append(normalized, canonical)
		}
	}
	sort.Strings(normalized)
	if policy.Mode == ModeAllowlist && len(normalized) == 0 {
		return Policy{}, errors.New("at least one allowed IP address is required")
	}
	policy.AllowedIPs = normalized
	return policy, nil
}

func (policy Policy) Allows(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsValid() {
		return false
	}
	switch policy.Mode {
	case ModeAll:
		return true
	case ModeLocal:
		return IsLocal(address)
	case ModeAllowlist:
		for _, value := range policy.AllowedIPs {
			prefix, err := parseNetwork(value)
			if err == nil && prefix.Contains(address) {
				return true
			}
		}
	}
	return false
}

func IsLocal(address netip.Addr) bool {
	address = address.Unmap()
	return address.IsValid() && (address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast())
}

func Load(db *sql.DB) (Policy, error) {
	if db == nil {
		return Policy{}, errors.New("administration access database is unavailable")
	}
	var raw string
	err := db.QueryRow("SELECT value FROM app_settings WHERE `key`=?", SettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultPolicy(), nil
	}
	if err != nil {
		return Policy{}, err
	}
	var policy Policy
	if err := json.Unmarshal([]byte(raw), &policy); err != nil {
		return Policy{}, err
	}
	return Normalize(policy)
}

func Save(db *sql.DB, policy Policy) (Policy, error) {
	policy, err := Normalize(policy)
	if err != nil {
		return Policy{}, err
	}
	data, err := json.Marshal(policy)
	if err != nil {
		return Policy{}, err
	}
	tx, err := db.Begin()
	if err != nil {
		return Policy{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM app_settings WHERE `key`=?", SettingKey); err != nil {
		return Policy{}, err
	}
	if _, err := tx.Exec("INSERT INTO app_settings(`key`,value,updated_at) VALUES(?,?,?)",
		SettingKey, string(data), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return Policy{}, err
	}
	if err := tx.Commit(); err != nil {
		return Policy{}, err
	}
	return policy, nil
}

func (controller *Controller) Decide(r *http.Request) (Decision, error) {
	policy, err := Load(controller.DB)
	if err != nil {
		return Decision{}, err
	}
	address, err := controller.ClientIP(r)
	if err != nil {
		return Decision{}, err
	}
	return Decision{Allowed: policy.Allows(address), ClientIP: address, Policy: policy}, nil
}

func (controller *Controller) ClientIP(r *http.Request) (netip.Addr, error) {
	peer, err := parseRequestAddress(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}, err
	}
	trusted := controller.TrustedProxies
	if len(trusted) == 0 {
		trusted = DefaultTrustedProxies()
	}
	if !contains(trusted, peer) {
		return peer, nil
	}
	forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
	if forwarded != "" {
		parts := strings.Split(forwarded, ",")
		var leftmost netip.Addr
		for index := len(parts) - 1; index >= 0; index-- {
			address, parseErr := parseRequestAddress(parts[index])
			if parseErr != nil {
				return netip.Addr{}, errors.New("invalid forwarded client address")
			}
			leftmost = address
			if !contains(trusted, address) {
				return address, nil
			}
		}
		if leftmost.IsValid() {
			return leftmost, nil
		}
	}
	if realIP := strings.TrimSpace(r.Header.Get("X-Real-IP")); realIP != "" {
		return parseRequestAddress(realIP)
	}
	return peer, nil
}

func parseNetwork(value string) (netip.Prefix, error) {
	value = strings.TrimSpace(value)
	if prefix, err := netip.ParsePrefix(value); err == nil {
		address := prefix.Addr()
		if address.Zone() != "" {
			return netip.Prefix{}, errors.New("IPv6 zones are not supported")
		}
		if address.Is4In6() && prefix.Bits() >= 96 {
			return netip.PrefixFrom(address.Unmap(), prefix.Bits()-96).Masked(), nil
		}
		return prefix.Masked(), nil
	}
	address, err := netip.ParseAddr(value)
	if err != nil || address.Zone() != "" {
		return netip.Prefix{}, errors.New("invalid address")
	}
	address = address.Unmap()
	return netip.PrefixFrom(address, address.BitLen()), nil
}

func parseRequestAddress(value string) (netip.Addr, error) {
	value = strings.TrimSpace(value)
	if addressPort, err := netip.ParseAddrPort(value); err == nil {
		return addressPort.Addr().Unmap(), nil
	}
	address, err := netip.ParseAddr(strings.Trim(value, "[]"))
	if err != nil || address.Zone() != "" {
		return netip.Addr{}, errors.New("invalid client address")
	}
	return address.Unmap(), nil
}

func contains(prefixes []netip.Prefix, address netip.Addr) bool {
	address = address.Unmap()
	for _, prefix := range prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}
