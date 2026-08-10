package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"chat-pwa-go/internal/httpx"

	qrcode "github.com/skip2/go-qrcode"
)

const sessionApprovalDuration = 5 * time.Minute

type DeviceSession struct {
	ID                string  `json:"id"`
	DeviceName        string  `json:"device_name"`
	DeviceType        string  `json:"device_type"`
	UserAgent         string  `json:"user_agent"`
	IPAddress         string  `json:"ip_address"`
	CreatedAt         string  `json:"created_at"`
	LastSeenAt        string  `json:"last_seen_at"`
	ExpiresAt         string  `json:"expires_at"`
	ApprovedAt        *string `json:"approved_at,omitempty"`
	ApprovalExpiresAt *string `json:"approval_expires_at,omitempty"`
	Current           bool    `json:"current"`
	Pending           bool    `json:"pending"`
}

type sessionApprovalInput struct {
	Token     string `json:"token"`
	Code      string `json:"code"`
	SessionID string `json:"session_id"`
}

func randomSessionToken(size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func randomApprovalCode() (string, error) {
	raw := make([]byte, 5)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	return encoded[:4] + "-" + encoded[4:], nil
}

func normalizeApprovalCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "-", "")
	value = strings.ReplaceAll(value, " ", "")
	return value
}

func sessionApprovalHash(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}

func sessionReference(sessionID string) string {
	digest := sha256.Sum256([]byte("vibration-session-reference:" + sessionID))
	return hex.EncodeToString(digest[:12])
}

func truncateSessionText(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func sessionDeviceMetadata(name, kind, userAgent string) (string, string) {
	name = truncateSessionText(name, 120)
	if name == "" {
		name = "Navigateur web"
	}
	kind = strings.ToLower(strings.TrimSpace(kind))
	switch kind {
	case "desktop", "mobile", "tablet", "browser":
	default:
		kind = "browser"
	}
	if userAgent == "" && name == "Navigateur web" {
		name = "Appareil non identifié"
	}
	return name, kind
}

func (h *Handler) requiresSessionApproval(userID int64) (bool, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = h.DB.Exec(`DELETE FROM sessions WHERE expires_at<=? OR (approved_at IS NULL AND approval_expires_at IS NOT NULL AND approval_expires_at<=?)`, now, now)
	var approved int
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id=? AND approved_at IS NOT NULL AND expires_at>?`, userID, now).Scan(&approved); err != nil {
		return false, err
	}
	return approved > 0, nil
}

func sessionApprovalURL(h *Handler, r *http.Request, token string) string {
	scheme := "http"
	if h.SecureCookies || r.TLS != nil || strings.EqualFold(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]), "https") {
		scheme = "https"
	}
	return scheme + "://" + r.Host + "/link-device.html#token=" + token
}

func sessionApprovalQRCode(value string) (string, error) {
	png, err := qrcode.Encode(value, qrcode.Medium, 320)
	if err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(png), nil
}

func (h *Handler) PendingSessionStatus(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := requestSessionID(r)
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var deviceName, expiresAt string
	var approvedAt, approvalExpiresAt sql.NullString
	if err := h.DB.QueryRow(`SELECT device_name,expires_at,approved_at,approval_expires_at FROM sessions WHERE id=?`, sessionID).
		Scan(&deviceName, &expiresAt, &approvedAt, &approvalExpiresAt); err != nil {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	now := time.Now().UTC()
	state := "pending"
	if approvedAt.Valid {
		state = "approved"
	} else if deadline, err := time.Parse(time.RFC3339Nano, approvalExpiresAt.String); err != nil || !deadline.After(now) {
		state = "expired"
		_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=?`, sessionID)
	}
	if expiry, err := time.Parse(time.RFC3339Nano, expiresAt); err != nil || !expiry.After(now) {
		state = "expired"
		_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=?`, sessionID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"state": state, "device_name": deviceName})
}

func (h *Handler) CancelPendingSession(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := requestSessionID(r)
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=? AND approved_at IS NULL`, sessionID)
	h.deleteSession(w, r)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) Sessions(w http.ResponseWriter, r *http.Request) {
	userID := UserID(r)
	currentID := SessionID(r)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = h.DB.Exec(`DELETE FROM sessions WHERE user_id=? AND (expires_at<=? OR (approved_at IS NULL AND approval_expires_at IS NOT NULL AND approval_expires_at<=?))`, userID, now, now)
	rows, err := h.DB.Query(`SELECT id,device_name,device_type,COALESCE(user_agent,''),COALESCE(ip_address,''),created_at,
		COALESCE(NULLIF(last_seen_at,''),created_at),expires_at,approved_at,approval_expires_at
		FROM sessions WHERE user_id=? AND expires_at>? ORDER BY approved_at IS NULL DESC,last_seen_at DESC,created_at DESC`, userID, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session lookup failed")
		return
	}
	defer rows.Close()
	result := make([]DeviceSession, 0)
	for rows.Next() {
		var rawID string
		var item DeviceSession
		var approvedAt, approvalExpiresAt sql.NullString
		if err := rows.Scan(&rawID, &item.DeviceName, &item.DeviceType, &item.UserAgent, &item.IPAddress, &item.CreatedAt,
			&item.LastSeenAt, &item.ExpiresAt, &approvedAt, &approvalExpiresAt); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "session lookup failed")
			return
		}
		item.ID = sessionReference(rawID)
		item.Current = subtle.ConstantTimeCompare([]byte(rawID), []byte(currentID)) == 1
		item.Pending = !approvedAt.Valid
		if approvedAt.Valid {
			item.ApprovedAt = &approvedAt.String
		}
		if approvalExpiresAt.Valid && item.Pending {
			item.ApprovalExpiresAt = &approvalExpiresAt.String
		}
		result = append(result, item)
	}
	if rows.Err() != nil {
		httpx.Error(w, http.StatusInternalServerError, "session lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) ApprovalPreview(w http.ResponseWriter, r *http.Request) {
	var input sessionApprovalInput
	if !httpx.Decode(w, r, &input) {
		return
	}
	if !h.allowAuthAttempt(w, r, "session-approval-preview", sessionReference(SessionID(r))) {
		return
	}
	pending, err := h.pendingSession(UserID(r), input)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "session approval request not found")
		return
	}
	httpx.JSON(w, http.StatusOK, pending)
}

func (h *Handler) ApproveSession(w http.ResponseWriter, r *http.Request) {
	var input sessionApprovalInput
	if !httpx.Decode(w, r, &input) {
		return
	}
	if !h.allowAuthAttempt(w, r, "session-approval", sessionReference(SessionID(r))) {
		return
	}
	pending, err := h.pendingSession(UserID(r), input)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "session approval request not found")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session approval failed")
		return
	}
	defer tx.Rollback()
	if err := enrollPendingSessionCredential(tx, UserID(r), pending.rawID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session approval failed")
		return
	}
	result, err := tx.Exec(`UPDATE sessions SET approved_at=?,approval_token_hash=NULL,approval_code_hash=NULL,approval_expires_at=NULL,
		device_challenge_hash=NULL,device_challenge_expires_at=NULL
		WHERE id=? AND user_id=? AND approved_at IS NULL`, now, pending.rawID, UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session approval failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "session approval request not found")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session approval failed")
		return
	}
	if h.Hub != nil {
		h.Hub.SendToUser(UserID(r), map[string]any{"type": "sessions_changed"})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "session_id": pending.ID})
}

func (h *Handler) RevokeSession(w http.ResponseWriter, r *http.Request) {
	reference := strings.TrimSpace(r.PathValue("id"))
	rawID, err := h.sessionIDForReference(UserID(r), reference)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "session not found")
		return
	}
	result, err := h.DB.Exec(`DELETE FROM sessions WHERE id=? AND user_id=?`, rawID, UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session revocation failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "session not found")
		return
	}
	h.sessionActivity().forget(rawID)
	current := subtle.ConstantTimeCompare([]byte(rawID), []byte(SessionID(r))) == 1
	if current {
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, SameSite: h.cookieSameSite(), Secure: h.SecureCookies, MaxAge: -1})
	}
	if h.Hub != nil {
		h.Hub.KickUser(UserID(r), map[string]any{"type": "sessions_changed"})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "current": current})
}

type pendingDeviceSession struct {
	DeviceSession
	rawID string
}

func (h *Handler) pendingSession(userID int64, input sessionApprovalInput) (pendingDeviceSession, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var row *sql.Row
	switch {
	case strings.TrimSpace(input.Token) != "":
		token := strings.TrimSpace(input.Token)
		if len(token) < 32 || len(token) > 128 {
			return pendingDeviceSession{}, sql.ErrNoRows
		}
		row = h.DB.QueryRow(`SELECT id,device_name,device_type,COALESCE(user_agent,''),COALESCE(ip_address,''),created_at,
			COALESCE(NULLIF(last_seen_at,''),created_at),expires_at,approval_expires_at FROM sessions
			WHERE user_id=? AND approved_at IS NULL AND approval_token_hash=? AND approval_expires_at>?`, userID, sessionApprovalHash(token), now)
	case normalizeApprovalCode(input.Code) != "":
		code := normalizeApprovalCode(input.Code)
		if len(code) != 8 {
			return pendingDeviceSession{}, sql.ErrNoRows
		}
		row = h.DB.QueryRow(`SELECT id,device_name,device_type,COALESCE(user_agent,''),COALESCE(ip_address,''),created_at,
			COALESCE(NULLIF(last_seen_at,''),created_at),expires_at,approval_expires_at FROM sessions
			WHERE user_id=? AND approved_at IS NULL AND approval_code_hash=? AND approval_expires_at>?`, userID, sessionApprovalHash(code), now)
	case strings.TrimSpace(input.SessionID) != "":
		rawID, err := h.sessionIDForReference(userID, strings.TrimSpace(input.SessionID))
		if err != nil {
			return pendingDeviceSession{}, err
		}
		row = h.DB.QueryRow(`SELECT id,device_name,device_type,COALESCE(user_agent,''),COALESCE(ip_address,''),created_at,
			COALESCE(NULLIF(last_seen_at,''),created_at),expires_at,approval_expires_at FROM sessions
			WHERE id=? AND user_id=? AND approved_at IS NULL AND approval_expires_at>?`, rawID, userID, now)
	default:
		return pendingDeviceSession{}, sql.ErrNoRows
	}
	var pending pendingDeviceSession
	var approvalExpiresAt string
	if err := row.Scan(&pending.rawID, &pending.DeviceName, &pending.DeviceType, &pending.UserAgent, &pending.IPAddress,
		&pending.CreatedAt, &pending.LastSeenAt, &pending.ExpiresAt, &approvalExpiresAt); err != nil {
		return pendingDeviceSession{}, err
	}
	pending.ID = sessionReference(pending.rawID)
	pending.Pending = true
	pending.ApprovalExpiresAt = &approvalExpiresAt
	return pending, nil
}

func (h *Handler) sessionIDForReference(userID int64, reference string) (string, error) {
	if len(reference) != 24 {
		return "", sql.ErrNoRows
	}
	rows, err := h.DB.Query(`SELECT id FROM sessions WHERE user_id=?`, userID)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for rows.Next() {
		var rawID string
		if rows.Scan(&rawID) == nil && subtle.ConstantTimeCompare([]byte(sessionReference(rawID)), []byte(reference)) == 1 {
			return rawID, nil
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return "", sql.ErrNoRows
}
