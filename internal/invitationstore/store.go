package invitationstore

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"regexp"
	"strings"
	"time"
)

var codePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{7,79}$`)

var ErrInvalidCode = errors.New("invalid invitation code")

// NormalizeCode keeps invitation URLs predictable and URL-safe while allowing
// administrators to use a memorable code such as "famille-2026".
func NormalizeCode(value string) (string, error) {
	code := strings.ToLower(strings.TrimSpace(value))
	if !codePattern.MatchString(code) {
		return "", ErrInvalidCode
	}
	return code, nil
}

func HashCode(code string) string {
	digest := sha256.Sum256([]byte(code))
	return hex.EncodeToString(digest[:])
}

// ActiveID verifies an invitation without consuming it. Consumption happens
// in the registration transaction so two concurrent registrations cannot use
// the same invitation.
func ActiveID(db *sql.DB, code string, now time.Time) (int64, bool, error) {
	normalized, err := NormalizeCode(code)
	if err != nil {
		return 0, false, nil
	}
	return activeIDQuery(db, HashCode(normalized), now)
}

func activeIDQuery(db interface {
	QueryRow(query string, args ...any) *sql.Row
}, hash string, now time.Time) (int64, bool, error) {
	var id int64
	var expiresAt string
	var usedAt, revokedAt sql.NullString
	err := db.QueryRow(`SELECT id,expires_at,used_at,revoked_at FROM invitation_contacts WHERE code_hash=?`, hash).
		Scan(&id, &expiresAt, &usedAt, &revokedAt)
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	deadline, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil || !deadline.After(now) || usedAt.Valid || revokedAt.Valid {
		return 0, false, nil
	}
	return id, true, nil
}

func Consume(tx *sql.Tx, id, userID int64, now time.Time) (bool, error) {
	result, err := tx.Exec(`UPDATE invitation_contacts SET used_at=?,accepted_user_id=?
		WHERE id=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?`,
		now.Format(time.RFC3339Nano), userID, id, now.Format(time.RFC3339Nano))
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}
