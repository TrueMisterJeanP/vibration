package auth

import (
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"
	"time"

	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/messageauth"
)

type TrustedDevice struct {
	ID         string `json:"id"`
	KeyID      string `json:"key_id"`
	DeviceName string `json:"device_name"`
	DeviceType string `json:"device_type"`
	CreatedAt  string `json:"created_at"`
	LastUsedAt string `json:"last_used_at"`
	Current    bool   `json:"current"`
}

type trustedDeviceProofInput struct {
	KeyID     string `json:"device_key_id"`
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}

type trustedDeviceEnrollmentInput struct {
	KeyID      string `json:"device_key_id"`
	PublicKey  string `json:"device_public_key"`
	DeviceName string `json:"device_name"`
	DeviceType string `json:"device_type"`
}

type trustedDeviceStore interface {
	Exec(query string, args ...any) (sql.Result, error)
	QueryRow(query string, args ...any) *sql.Row
}

func canonicalTrustedDeviceCredential(keyID, publicKey string) (string, string, error) {
	keyID = strings.ToLower(strings.TrimSpace(keyID))
	publicKey = strings.TrimSpace(publicKey)
	if keyID == "" && publicKey == "" {
		return "", "", nil
	}
	if keyID == "" || publicKey == "" {
		return "", "", errors.New("incomplete trusted device credential")
	}
	canonical, calculatedID, _, err := messageauth.CanonicalPublicKey(publicKey)
	if err != nil || subtle.ConstantTimeCompare([]byte(calculatedID), []byte(keyID)) != 1 {
		return "", "", errors.New("invalid trusted device credential")
	}
	return calculatedID, canonical, nil
}

func (h *Handler) trustedDeviceForKey(userID int64, keyID string) (string, bool, error) {
	if keyID == "" {
		return "", false, nil
	}
	var id string
	err := h.DB.QueryRow(`SELECT id FROM trusted_devices WHERE user_id=? AND key_id=?`, userID, keyID).Scan(&id)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return id, err == nil, err
}

func (h *Handler) hasTrustedDevices(userID int64) (bool, error) {
	var count int
	err := h.DB.QueryRow(`SELECT COUNT(*) FROM trusted_devices WHERE user_id=?`, userID).Scan(&count)
	return count > 0, err
}

func enrollTrustedDevice(store trustedDeviceStore, userID int64, keyID, publicKey, deviceName, deviceType string) (string, error) {
	var id string
	if err := store.QueryRow(`SELECT id FROM trusted_devices WHERE user_id=? AND key_id=?`, userID, keyID).Scan(&id); err == nil {
		_, err = store.Exec(`UPDATE trusted_devices SET device_name=?,device_type=?,last_used_at=? WHERE id=? AND user_id=?`,
			deviceName, deviceType, time.Now().UTC().Format(time.RFC3339Nano), id, userID)
		return id, err
	} else if err != sql.ErrNoRows {
		return "", err
	}
	id, err := randomSessionToken(24)
	if err != nil {
		return "", err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = store.Exec(`INSERT INTO trusted_devices(id,user_id,key_id,public_key,device_name,device_type,created_at,last_used_at)
		VALUES(?,?,?,?,?,?,?,?)`, id, userID, keyID, publicKey, deviceName, deviceType, now, now)
	return id, err
}

func (h *Handler) enrollSessionCredential(userID int64, sessionID string, input authRequest) error {
	if input.DeviceKeyID == "" || input.DevicePublicKey == "" {
		return nil
	}
	name, kind := sessionDeviceMetadata(input.DeviceName, input.DeviceType, "")
	deviceID, err := enrollTrustedDevice(h.DB, userID, input.DeviceKeyID, input.DevicePublicKey, name, kind)
	if err != nil {
		return err
	}
	_, err = h.DB.Exec(`UPDATE sessions SET trusted_device_id=? WHERE id=? AND user_id=?`, deviceID, sessionID, userID)
	return err
}

func enrollPendingSessionCredential(tx *sql.Tx, userID int64, sessionID string) error {
	var keyID, publicKey sql.NullString
	var deviceName, deviceType string
	if err := tx.QueryRow(`SELECT requested_device_key_id,requested_device_public_key,device_name,device_type
		FROM sessions WHERE id=? AND user_id=?`, sessionID, userID).Scan(&keyID, &publicKey, &deviceName, &deviceType); err != nil {
		return err
	}
	if !keyID.Valid || !publicKey.Valid {
		return nil
	}
	canonicalID, canonicalKey, err := canonicalTrustedDeviceCredential(keyID.String, publicKey.String)
	if err != nil {
		return err
	}
	deviceID, err := enrollTrustedDevice(tx, userID, canonicalID, canonicalKey, deviceName, deviceType)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE sessions SET trusted_device_id=? WHERE id=? AND user_id=?`, deviceID, sessionID, userID)
	return err
}

func (h *Handler) TrustedDevices(w http.ResponseWriter, r *http.Request) {
	rows, err := h.DB.Query(`SELECT d.id,d.key_id,d.device_name,d.device_type,d.created_at,d.last_used_at,
		EXISTS(SELECT 1 FROM sessions s WHERE s.id=? AND s.trusted_device_id=d.id)
		FROM trusted_devices d WHERE d.user_id=? ORDER BY d.last_used_at DESC,d.created_at DESC`, SessionID(r), UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device lookup failed")
		return
	}
	defer rows.Close()
	result := make([]TrustedDevice, 0)
	for rows.Next() {
		var device TrustedDevice
		if err := rows.Scan(&device.ID, &device.KeyID, &device.DeviceName, &device.DeviceType, &device.CreatedAt, &device.LastUsedAt, &device.Current); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "trusted device lookup failed")
			return
		}
		result = append(result, device)
	}
	if rows.Err() != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) EnrollTrustedDevice(w http.ResponseWriter, r *http.Request) {
	var input trustedDeviceEnrollmentInput
	if !httpx.Decode(w, r, &input) {
		return
	}
	keyID, publicKey, err := canonicalTrustedDeviceCredential(input.KeyID, input.PublicKey)
	if err != nil || keyID == "" {
		httpx.Error(w, http.StatusBadRequest, "invalid trusted device credential")
		return
	}
	var count int
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM trusted_devices WHERE user_id=?`, UserID(r)).Scan(&count); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device lookup failed")
		return
	}
	var existing string
	existingErr := h.DB.QueryRow(`SELECT id FROM trusted_devices WHERE user_id=? AND key_id=?`, UserID(r), keyID).Scan(&existing)
	if count > 0 && existingErr == sql.ErrNoRows {
		httpx.Error(w, http.StatusConflict, "trusted device approval required")
		return
	}
	name, kind := sessionDeviceMetadata(input.DeviceName, input.DeviceType, r.UserAgent())
	deviceID, err := enrollTrustedDevice(h.DB, UserID(r), keyID, publicKey, name, kind)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device enrollment failed")
		return
	}
	if _, err := h.DB.Exec(`UPDATE sessions SET trusted_device_id=? WHERE id=? AND user_id=?`, deviceID, SessionID(r), UserID(r)); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device enrollment failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "id": deviceID})
}

func (h *Handler) ProveTrustedDevice(w http.ResponseWriter, r *http.Request) {
	sessionID, ok := requestSessionID(r)
	if !ok {
		httpx.Error(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var input trustedDeviceProofInput
	if !httpx.Decode(w, r, &input) {
		return
	}
	if !h.allowAuthAttempt(w, r, "trusted-device-proof", sessionReference(sessionID)) {
		return
	}
	var userID int64
	var storedKeyID, publicKey, challengeHash, challengeExpires string
	var approvedAt sql.NullString
	err := h.DB.QueryRow(`SELECT s.user_id,d.key_id,d.public_key,s.device_challenge_hash,s.device_challenge_expires_at,s.approved_at
		FROM sessions s JOIN trusted_devices d ON d.id=s.trusted_device_id AND d.user_id=s.user_id WHERE s.id=?`, sessionID).
		Scan(&userID, &storedKeyID, &publicKey, &challengeHash, &challengeExpires, &approvedAt)
	deadline, deadlineErr := time.Parse(time.RFC3339Nano, challengeExpires)
	if err != nil || approvedAt.Valid || deadlineErr != nil || !deadline.After(time.Now().UTC()) ||
		subtle.ConstantTimeCompare([]byte(storedKeyID), []byte(strings.ToLower(strings.TrimSpace(input.KeyID)))) != 1 ||
		subtle.ConstantTimeCompare([]byte(challengeHash), []byte(sessionApprovalHash(strings.TrimSpace(input.Challenge)))) != 1 {
		httpx.Error(w, http.StatusUnauthorized, "trusted device proof failed")
		return
	}
	signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(input.Signature))
	if err != nil || messageauth.VerifyRaw(publicKey, []byte(strings.TrimSpace(input.Challenge)), signature) != nil {
		httpx.Error(w, http.StatusUnauthorized, "trusted device proof failed")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE sessions SET approved_at=?,approval_token_hash=NULL,approval_code_hash=NULL,approval_expires_at=NULL,
		device_challenge_hash=NULL,device_challenge_expires_at=NULL WHERE id=? AND approved_at IS NULL`, now, sessionID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device proof failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusUnauthorized, "trusted device proof failed")
		return
	}
	_, _ = h.DB.Exec(`UPDATE trusted_devices SET last_used_at=? WHERE id=(SELECT trusted_device_id FROM sessions WHERE id=?)`, now, sessionID)
	if h.Hub != nil {
		h.Hub.SendToUser(userID, map[string]any{"type": "sessions_changed"})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) RevokeTrustedDevice(w http.ResponseWriter, r *http.Request) {
	deviceID := strings.TrimSpace(r.PathValue("id"))
	if len(deviceID) < 24 || len(deviceID) > 64 {
		httpx.Error(w, http.StatusNotFound, "trusted device not found")
		return
	}
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device revocation failed")
		return
	}
	defer tx.Rollback()
	var current int
	_ = tx.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id=? AND user_id=? AND trusted_device_id=?`, SessionID(r), UserID(r), deviceID).Scan(&current)
	if _, err := tx.Exec(`DELETE FROM sessions WHERE user_id=? AND trusted_device_id=?`, UserID(r), deviceID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device revocation failed")
		return
	}
	result, err := tx.Exec(`DELETE FROM trusted_devices WHERE id=? AND user_id=?`, deviceID, UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device revocation failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "trusted device not found")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device revocation failed")
		return
	}
	if current > 0 {
		http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, SameSite: h.cookieSameSite(), Secure: h.SecureCookies, MaxAge: -1})
	}
	if h.Hub != nil {
		h.Hub.KickUser(UserID(r), map[string]any{"type": "sessions_changed"})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "current": current > 0})
}
