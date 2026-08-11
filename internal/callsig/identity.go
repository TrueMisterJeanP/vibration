// Package callsig defines the federated call signalling protocol: a canonical
// participant identity that does not depend on any database, and a versioned,
// expiring event envelope carried between instances.
//
// Local numeric user identifiers are allocated independently by each instance.
// Two browsers connected to two different servers therefore cannot use them to
// agree on anything: the same participant has a different id on each side, and
// two different participants routinely share one. Every decision that must hold
// across instances — who creates the offer, who a signal is addressed to — is
// made on the canonical identity below. Numeric ids are re-attached only at the
// boundary between the receiving server and its own WebSocket clients.
package callsig

import (
	"net/url"
	"regexp"
	"strings"
)

// usernamePattern matches the federated username shape already enforced by the
// federation handlers, so an identity can never carry a name that could not be
// resolved to a real account.
var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

// LocalInstance is the instance part used when no federation base URL is
// configured. A community deployment still needs stable identities for its own
// two browsers, and "local" can never collide with a real base URL because it
// carries no scheme.
const LocalInstance = "local"

// Identity is a call participant, canonically addressable across instances.
type Identity struct {
	Instance string `json:"instance"`
	Username string `json:"username"`
}

// NewIdentity normalizes an instance base URL and a username into an identity.
// Normalization is total: scheme and host are lowercased, the default port for
// the scheme is dropped, trailing slashes are removed and the username is
// lowercased. Two spellings of the same participant therefore always produce
// the same canonical string.
func NewIdentity(instance, username string) Identity {
	return Identity{Instance: NormalizeInstance(instance), Username: normalizeUsername(username)}
}

// NormalizeInstance canonicalizes an instance base URL.
func NormalizeInstance(instance string) string {
	instance = strings.TrimSpace(instance)
	if instance == "" {
		return LocalInstance
	}
	if !strings.Contains(instance, "://") {
		return strings.ToLower(strings.TrimRight(instance, "/"))
	}
	parsed, err := url.Parse(instance)
	if err != nil || parsed.Host == "" {
		return strings.ToLower(strings.TrimRight(instance, "/"))
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Host)
	if port := parsed.Port(); (port == "443" && parsed.Scheme == "https") || (port == "80" && parsed.Scheme == "http") {
		host = strings.ToLower(parsed.Hostname())
	}
	parsed.Host = host
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.User = nil
	return strings.TrimRight(parsed.String(), "/")
}

func normalizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// Canonical is the wire and comparison form of an identity.
func (i Identity) Canonical() string {
	if i.Instance == "" || i.Username == "" {
		return ""
	}
	return i.Instance + "|" + i.Username
}

// Valid reports whether the identity is well formed enough to be routed.
func (i Identity) Valid() bool {
	if i.Instance != LocalInstance {
		if len(i.Instance) > 512 {
			return false
		}
		parsed, err := url.Parse(i.Instance)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return false
		}
	}
	return usernamePattern.MatchString(i.Username)
}

// Equal compares two identities in canonical form.
func (i Identity) Equal(other Identity) bool {
	return i.Canonical() != "" && i.Canonical() == other.Canonical()
}

// IsZero reports an unset identity.
func (i Identity) IsZero() bool { return i.Instance == "" && i.Username == "" }

// ParseIdentity reads a canonical identity string.
func ParseIdentity(value string) (Identity, bool) {
	instance, username, found := strings.Cut(strings.TrimSpace(value), "|")
	// An empty instance segment is rejected rather than defaulted to "local":
	// a canonical string always spells its instance out, and silently adopting
	// the local one would let a peer address a stranger by omission.
	if !found || strings.TrimSpace(instance) == "" {
		return Identity{}, false
	}
	identity := NewIdentity(instance, username)
	return identity, identity.Valid()
}

// Polite decides, for one pair of participants, which side plays the polite
// role of the WebRTC "perfect negotiation" pattern. The rule is a pure function
// of the two canonical identities, so both browsers reach opposite conclusions
// without exchanging anything and without consulting a database.
func Polite(local, remote Identity) bool {
	return local.Canonical() < remote.Canonical()
}
