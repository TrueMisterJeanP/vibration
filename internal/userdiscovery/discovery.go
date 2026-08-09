package userdiscovery

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/hex"
	"strings"
)

const codePrefix = "VIB"

// GenerateCode returns a 160-bit discovery secret and the SHA-256 fingerprint
// stored by the server. The clear-text code is returned only once.
func GenerateCode() (string, string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	groups := make([]string, 0, len(encoded)/4)
	for index := 0; index < len(encoded); index += 4 {
		groups = append(groups, encoded[index:index+4])
	}
	code := codePrefix + "-" + strings.Join(groups, "-")
	return code, HashCode(code), nil
}

// NormalizeCode accepts the displayed form as well as copies without spaces or
// separators. An empty result means that the value is not a discovery code.
func NormalizeCode(value string) string {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	normalized = strings.NewReplacer("-", "", " ", "", "\t", "", "\r", "", "\n", "").Replace(normalized)
	if len(normalized) != len(codePrefix)+32 || !strings.HasPrefix(normalized, codePrefix) {
		return ""
	}
	for _, character := range normalized[len(codePrefix):] {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", character) {
			return ""
		}
	}
	return normalized
}

func HashCode(value string) string {
	normalized := NormalizeCode(value)
	if normalized == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(digest[:])
}

// CanInitiate reports whether requester may establish a new local relationship
// with target. Existing accepted relationships remain usable after the target
// becomes invisible, while a new relationship requires the exact secret.
type rowQuerier interface {
	QueryRow(query string, args ...any) *sql.Row
}

func CanInitiate(database rowQuerier, requesterID, targetID int64, code string) (bool, error) {
	var discoverable, remote, banned bool
	var storedHash sql.NullString
	err := database.QueryRow(`SELECT is_discoverable,is_remote,is_banned,discovery_code_hash
		FROM users WHERE id=?`, targetID).Scan(&discoverable, &remote, &banned, &storedHash)
	if err != nil {
		return false, err
	}
	if remote || banned {
		return false, nil
	}
	if discoverable {
		return true, nil
	}
	if suppliedHash := HashCode(code); suppliedHash != "" && storedHash.Valid &&
		subtle.ConstantTimeCompare([]byte(suppliedHash), []byte(storedHash.String)) == 1 {
		return true, nil
	}

	var known int
	err = database.QueryRow(`SELECT COUNT(*) FROM (
		SELECT 1 FROM contacts
		WHERE ((owner_id=? AND contact_user_id=?) OR (owner_id=? AND contact_user_id=?))
			AND (status='accepted' OR (owner_id=? AND contact_user_id=? AND status='pending'))
		UNION
		SELECT 1 FROM conversation_members mine
		JOIN conversation_members peer ON peer.conversation_id=mine.conversation_id
		WHERE mine.user_id=? AND mine.role<>'pending' AND peer.user_id=? AND peer.role<>'pending'
	) known_relationships`, requesterID, targetID, targetID, requesterID, targetID, requesterID, requesterID, targetID).Scan(&known)
	return known > 0, err
}
