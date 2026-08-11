package settings

import (
	"database/sql"
	"encoding/json"
	"strings"

	"chat-pwa-go/internal/config"
)

const WebRTCSettingsKey = "webrtc_settings"

const (
	TURNTransportTLS   = "tls"
	TURNTransportPlain = "plain"
)

const (
	// RelayPolicyAll lets the browser try host, server-reflexive and relayed
	// candidates. It is the right default: a direct path is cheaper and lower
	// latency than a TURN relay whenever the network allows one.
	RelayPolicyAll = "all"
	// RelayPolicyRelay forces every candidate through TURN. It exists to make a
	// TURN deployment testable end to end: with it the call either works through
	// Coturn or fails outright, instead of quietly succeeding over a direct path
	// and leaving a broken relay undetected until a symmetric NAT hits it.
	RelayPolicyRelay = "relay"
)

// NormalizeRelayPolicy maps any input onto a policy the browser understands.
func NormalizeRelayPolicy(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), RelayPolicyRelay) {
		return RelayPolicyRelay
	}
	return RelayPolicyAll
}

type WebRTCConfig struct {
	ICEServers            []config.ICEServer `json:"ice_servers"`
	PublicFallbackURLs    []string           `json:"public_fallback_urls"`
	RelayPolicy           string             `json:"relay_policy"`
	PrivateTURNConfigured bool               `json:"private_turn_configured"`
	Source                string             `json:"source"`
}

type WebRTCDefaults struct {
	ICEServers         []config.ICEServer
	PublicFallbackURLs []string
	RelayPolicy        string
}

type WebRTCSettings struct {
	TURNURLs           []string `json:"turn_urls"`
	TURNTransport      string   `json:"turn_transport"`
	TURNUsername       string   `json:"turn_username"`
	TURNCredential     string   `json:"turn_credential,omitempty"`
	PublicFallbackURLs []string `json:"public_fallback_urls"`
	RelayPolicy        string   `json:"relay_policy"`
}

type WebRTCAdminSettings struct {
	TURNURLs              []string `json:"turn_urls"`
	TURNTransport         string   `json:"turn_transport"`
	TURNUsername          string   `json:"turn_username"`
	TURNCredential        string   `json:"turn_credential,omitempty"`
	TURNCredentialSet     bool     `json:"turn_credential_set"`
	PublicFallbackURLs    []string `json:"public_fallback_urls"`
	RelayPolicy           string   `json:"relay_policy"`
	UsingEnvironment      bool     `json:"using_environment"`
	PrivateTURNConfigured bool     `json:"private_turn_configured"`
}

func EffectiveWebRTCConfig(db *sql.DB, defaults WebRTCDefaults) (WebRTCConfig, error) {
	admin, configured, err := LoadWebRTCSettings(db)
	if err != nil {
		return WebRTCConfig{}, err
	}
	if configured {
		return webRTCConfigFromSettings(admin, "admin"), nil
	}
	return WebRTCConfig{
		ICEServers:            defaults.ICEServers,
		PublicFallbackURLs:    defaults.PublicFallbackURLs,
		RelayPolicy:           NormalizeRelayPolicy(defaults.RelayPolicy),
		PrivateTURNConfigured: hasTURN(defaults.ICEServers, defaults.PublicFallbackURLs),
		Source:                "environment",
	}, nil
}

func LoadWebRTCAdminSettings(db *sql.DB, defaults WebRTCDefaults) (WebRTCAdminSettings, error) {
	stored, configured, err := LoadWebRTCSettings(db)
	if err != nil {
		return WebRTCAdminSettings{}, err
	}
	if configured {
		return WebRTCAdminSettings{
			TURNURLs:              stored.TURNURLs,
			TURNTransport:         stored.TURNTransport,
			TURNUsername:          stored.TURNUsername,
			TURNCredentialSet:     strings.TrimSpace(stored.TURNCredential) != "",
			PublicFallbackURLs:    stored.PublicFallbackURLs,
			RelayPolicy:           NormalizeRelayPolicy(stored.RelayPolicy),
			UsingEnvironment:      false,
			PrivateTURNConfigured: len(stored.TURNURLs) > 0,
		}, nil
	}
	turnURLs, username, credentialSet, turnTransport := splitDefaults(defaults)
	return WebRTCAdminSettings{
		TURNURLs:              turnURLs,
		TURNTransport:         turnTransport,
		TURNUsername:          username,
		TURNCredentialSet:     credentialSet,
		PublicFallbackURLs:    defaults.PublicFallbackURLs,
		RelayPolicy:           NormalizeRelayPolicy(defaults.RelayPolicy),
		UsingEnvironment:      true,
		PrivateTURNConfigured: len(turnURLs) > 0,
	}, nil
}

func LoadWebRTCSettings(db *sql.DB) (WebRTCSettings, bool, error) {
	var raw string
	err := db.QueryRow("SELECT value FROM app_settings WHERE `key`=?", WebRTCSettingsKey).Scan(&raw)
	if err == sql.ErrNoRows {
		return WebRTCSettings{}, false, nil
	}
	if err != nil {
		return WebRTCSettings{}, false, err
	}
	var value WebRTCSettings
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return WebRTCSettings{}, false, err
	}
	value.TURNURLs = cleanURLList(value.TURNURLs)
	value.PublicFallbackURLs = cleanURLList(value.PublicFallbackURLs)
	value.TURNTransport = EffectiveTURNTransport(value.TURNTransport, value.TURNURLs)
	value.TURNURLs = ApplyTURNTransport(value.TURNURLs, value.TURNTransport)
	value.TURNUsername = strings.TrimSpace(value.TURNUsername)
	value.RelayPolicy = NormalizeRelayPolicy(value.RelayPolicy)
	return value, true, nil
}

func SaveWebRTCSettings(db *sql.DB, value WebRTCSettings) error {
	value.TURNURLs = cleanURLList(value.TURNURLs)
	value.PublicFallbackURLs = cleanURLList(value.PublicFallbackURLs)
	value.TURNTransport = EffectiveTURNTransport(value.TURNTransport, value.TURNURLs)
	value.TURNURLs = ApplyTURNTransport(value.TURNURLs, value.TURNTransport)
	value.TURNUsername = strings.TrimSpace(value.TURNUsername)
	value.TURNCredential = strings.TrimSpace(value.TURNCredential)
	value.RelayPolicy = NormalizeRelayPolicy(value.RelayPolicy)
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return setAppSetting(db, WebRTCSettingsKey, string(data))
}

func DeleteWebRTCSettings(db *sql.DB) error {
	_, err := db.Exec("DELETE FROM app_settings WHERE `key`=?", WebRTCSettingsKey)
	return err
}

func webRTCConfigFromSettings(value WebRTCSettings, source string) WebRTCConfig {
	fallbacks := value.PublicFallbackURLs
	if len(fallbacks) == 0 {
		fallbacks = []string{"stun:stun.l.google.com:19302"}
	}
	servers := make([]config.ICEServer, 0, 2)
	if len(value.TURNURLs) > 0 {
		servers = append(servers, config.ICEServer{
			URLs:       value.TURNURLs,
			Username:   value.TURNUsername,
			Credential: value.TURNCredential,
		})
	}
	servers = append(servers, config.ICEServer{URLs: fallbacks})
	policy := NormalizeRelayPolicy(value.RelayPolicy)
	// A relay-only policy without a TURN server would produce zero usable
	// candidates and every call would fail to connect with no explanation.
	if policy == RelayPolicyRelay && len(value.TURNURLs) == 0 {
		policy = RelayPolicyAll
	}
	return WebRTCConfig{
		ICEServers:            servers,
		PublicFallbackURLs:    fallbacks,
		RelayPolicy:           policy,
		PrivateTURNConfigured: len(value.TURNURLs) > 0,
		Source:                source,
	}
}

func splitDefaults(defaults WebRTCDefaults) ([]string, string, bool, string) {
	for _, server := range defaults.ICEServers {
		urls := cleanURLList(server.URLs)
		if len(urls) == 0 || !hasTURN([]config.ICEServer{server}, defaults.PublicFallbackURLs) {
			continue
		}
		return urls, server.Username, strings.TrimSpace(server.Credential) != "", TURNTransportFromURLs(urls)
	}
	return nil, "", false, TURNTransportTLS
}

func hasTURN(servers []config.ICEServer, publicFallbackURLs []string) bool {
	fallbacks := map[string]struct{}{}
	for _, url := range publicFallbackURLs {
		fallbacks[url] = struct{}{}
	}
	for _, server := range servers {
		for _, url := range server.URLs {
			_, fallback := fallbacks[url]
			if !fallback && strings.HasPrefix(strings.ToLower(url), "turn") {
				return true
			}
		}
	}
	return false
}

func NormalizeTURNTransport(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case TURNTransportPlain, "turn", "unencrypted", "non-chiffre", "non_chiffre":
		return TURNTransportPlain
	default:
		return TURNTransportTLS
	}
}

func EffectiveTURNTransport(value string, urls []string) string {
	if strings.TrimSpace(value) != "" {
		return NormalizeTURNTransport(value)
	}
	return TURNTransportFromURLs(urls)
}

func TURNTransportFromURLs(urls []string) string {
	for _, url := range urls {
		lower := strings.ToLower(strings.TrimSpace(url))
		if strings.HasPrefix(lower, "turn:") {
			return TURNTransportPlain
		}
		if strings.HasPrefix(lower, "turns:") {
			return TURNTransportTLS
		}
	}
	return TURNTransportTLS
}

func ApplyTURNTransport(urls []string, transport string) []string {
	scheme := "turns:"
	if NormalizeTURNTransport(transport) == TURNTransportPlain {
		scheme = "turn:"
	}
	next := make([]string, 0, len(urls))
	for _, url := range urls {
		lower := strings.ToLower(strings.TrimSpace(url))
		switch {
		case strings.HasPrefix(lower, "turns:"):
			next = append(next, scheme+url[len("turns:"):])
		case strings.HasPrefix(lower, "turn:"):
			next = append(next, scheme+url[len("turn:"):])
		default:
			next = append(next, url)
		}
	}
	return next
}

func cleanURLList(values []string) []string {
	clean := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimRight(strings.TrimSpace(value), "/")
		if value != "" {
			clean = append(clean, value)
		}
	}
	return clean
}
