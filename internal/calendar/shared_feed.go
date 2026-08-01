package calendar

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
	"golang.org/x/crypto/bcrypt"
)

const sharedFeedSnapshotLimit = 4 << 20

func (h *Handler) CreateSharedFeed(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Password string `json:"password"`
		Snapshot string `json:"snapshot"`
	}
	if !httpx.DecodeWithLimit(w, r, &input, sharedFeedSnapshotLimit+16<<10) {
		return
	}
	if !validSharedFeedSnapshot(input.Snapshot) {
		httpx.Error(w, http.StatusBadRequest, "invalid calendar feed")
		return
	}
	userID := auth.UserID(r)
	if !h.verifySharedFeedPassword(r, userID, input.Password) {
		httpx.Error(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}
	token, tokenHash, err := newSharedFeedToken()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed creation failed")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed creation failed")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE calendar_feeds SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL`, now, userID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed creation failed")
		return
	}
	result, err := tx.Exec(`INSERT INTO calendar_feeds(user_id,token_hash,snapshot,created_at,updated_at)
		VALUES(?,?,?,?,?)`, userID, tokenHash, input.Snapshot, now, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed creation failed")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed creation failed")
		return
	}
	id, _ := result.LastInsertId()
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": id, "token": token, "created_at": now, "updated_at": now,
	})
}

func (h *Handler) ListSharedFeeds(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(`SELECT id,created_at,updated_at,revoked_at FROM calendar_feeds
		WHERE user_id=? ORDER BY id DESC`, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed lookup failed")
		return
	}
	defer rows.Close()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var id int64
		var createdAt, updatedAt string
		var revokedAt sql.NullString
		if err := rows.Scan(&id, &createdAt, &updatedAt, &revokedAt); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "calendar feed lookup failed")
			return
		}
		result = append(result, map[string]any{
			"id": id, "created_at": createdAt, "updated_at": updatedAt,
			"revoked_at": nullableFeedString(revokedAt), "active": !revokedAt.Valid,
		})
	}
	if err := rows.Err(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) UpdateSharedFeed(w http.ResponseWriter, r *http.Request) {
	feedID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		Snapshot string `json:"snapshot"`
	}
	if !httpx.DecodeWithLimit(w, r, &input, sharedFeedSnapshotLimit+16<<10) {
		return
	}
	if !validSharedFeedSnapshot(input.Snapshot) {
		httpx.Error(w, http.StatusBadRequest, "invalid calendar feed")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE calendar_feeds SET snapshot=?,updated_at=?
		WHERE id=? AND user_id=? AND revoked_at IS NULL`, input.Snapshot, now, feedID, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		httpx.Error(w, http.StatusNotFound, "calendar feed not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"id": feedID, "updated_at": now})
}

func (h *Handler) RevokeSharedFeed(w http.ResponseWriter, r *http.Request) {
	feedID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE calendar_feeds SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL`,
		now, feedID, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "calendar feed revocation failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		httpx.Error(w, http.StatusNotFound, "calendar feed not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"revoked": true, "revoked_at": now})
}

func (h *Handler) SharedFeed(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.PathValue("token"))
	if !validSharedFeedToken(token) {
		http.NotFound(w, r)
		return
	}
	userID, ok := h.authenticate(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Basic realm="Vibration shared calendar", charset="UTF-8"`)
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "Calendar authentication required", http.StatusUnauthorized)
		return
	}
	var snapshot string
	err := h.DB.QueryRow(`SELECT snapshot FROM calendar_feeds WHERE token_hash=? AND user_id=? AND revoked_at IS NULL`,
		sharedFeedTokenHash(token), userID).Scan(&snapshot)
	if err != nil {
		if err == sql.ErrNoRows {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "Calendar unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="vibration-calendar.ics"`)
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Vary", "Authorization")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(snapshot))
}

func (h *Handler) verifySharedFeedPassword(r *http.Request, userID int64, password string) bool {
	if password == "" {
		return false
	}
	if h.AuthLimiter != nil && !h.AuthLimiter.Allow("calendar-feed-create:"+clientAddress(r)+":"+fmtInt64(userID)) {
		return false
	}
	var passwordHash string
	if err := h.DB.QueryRow(`SELECT password_hash FROM users WHERE id=?`, userID).Scan(&passwordHash); err != nil {
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) == nil
}

func newSharedFeedToken() (string, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	return token, sharedFeedTokenHash(token), nil
}

func sharedFeedTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func validSharedFeedToken(token string) bool {
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(decoded) == 32
}

func validSharedFeedSnapshot(snapshot string) bool {
	trimmed := strings.TrimSpace(snapshot)
	return len(snapshot) > 0 && len(snapshot) <= sharedFeedSnapshotLimit &&
		strings.HasPrefix(trimmed, "BEGIN:VCALENDAR") && strings.HasSuffix(trimmed, "END:VCALENDAR")
}

func nullableFeedString(value sql.NullString) any {
	if !value.Valid {
		return nil
	}
	return value.String
}

func fmtInt64(value int64) string {
	return strconv.FormatInt(value, 10)
}
