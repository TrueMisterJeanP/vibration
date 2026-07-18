package files

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
)

const shareTokenBytes = 32

type publicShare struct {
	ID             int64
	EncryptedName  string
	EncryptedMIME  string
	EncryptedData  []byte
	IV             string
	Size           int64
	ExpiresAt      string
	RevokedAt      sql.NullString
	DownloadCount  int64
	LastDownloaded sql.NullString
}

func (h *Handler) CreateShare(w http.ResponseWriter, r *http.Request) {
	fileID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		EncryptedName    string `json:"encrypted_name"`
		EncryptedMIME    string `json:"encrypted_mime"`
		EncryptedData    string `json:"encrypted_data"`
		IV               string `json:"iv"`
		Size             int64  `json:"size"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if len(input.EncryptedName) < 10 || len(input.EncryptedName) > 4096 ||
		len(input.EncryptedMIME) < 10 || len(input.EncryptedMIME) > 4096 ||
		len(input.IV) < 8 || len(input.IV) > 128 || input.Size <= 0 || input.Size > maxFileSize {
		httpx.Error(w, http.StatusBadRequest, "invalid encrypted file share")
		return
	}
	data, err := base64.StdEncoding.DecodeString(input.EncryptedData)
	if err != nil || int64(len(data)) != input.Size+16 {
		httpx.Error(w, http.StatusBadRequest, "invalid encrypted file share")
		return
	}
	expiresAt, valid := fileShareExpiry(input.ExpiresInSeconds)
	if !valid {
		httpx.Error(w, http.StatusBadRequest, "invalid file share expiration")
		return
	}
	userID := auth.UserID(r)
	now := time.Now().UTC()
	var messageExpires sql.NullString
	err = h.DB.QueryRow(`SELECT m.expires_at FROM files f JOIN messages m ON m.id=f.message_id
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
		WHERE f.id=? AND cm.user_id=? AND cm.role<>'pending' AND m.created_at>=cm.created_at
		AND (m.expires_at IS NULL OR m.expires_at>?)`, fileID, userID, now.Format(time.RFC3339Nano)).Scan(&messageExpires)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "file not found")
		return
	}
	if messageExpires.Valid {
		if messageDeadline, parseErr := time.Parse(time.RFC3339Nano, messageExpires.String); parseErr == nil && messageDeadline.Before(expiresAt) {
			expiresAt = messageDeadline
		}
	}
	_, _ = h.DB.Exec(`DELETE FROM file_shares WHERE file_id=? AND created_by=? AND (revoked_at IS NOT NULL OR expires_at<=?)`,
		fileID, userID, now.Format(time.RFC3339Nano))
	var activeShares int
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM file_shares WHERE file_id=? AND created_by=? AND revoked_at IS NULL AND expires_at>?`,
		fileID, userID, now.Format(time.RFC3339Nano)).Scan(&activeShares); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file share lookup failed")
		return
	}
	if activeShares >= 10 {
		httpx.Error(w, http.StatusConflict, "too many active file shares")
		return
	}
	token, tokenHash, err := newShareToken()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file share creation failed")
		return
	}
	createdAt := now.Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`INSERT INTO file_shares(file_id,created_by,token_hash,encrypted_name,encrypted_mime,encrypted_data,iv,size,expires_at,created_at)
		VALUES(?,?,?,?,?,?,?,?,?,?)`, fileID, userID, tokenHash, input.EncryptedName, input.EncryptedMIME, data, input.IV, input.Size,
		expiresAt.Format(time.RFC3339Nano), createdAt)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file share creation failed")
		return
	}
	id, _ := result.LastInsertId()
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": id, "token": token, "expires_at": expiresAt.Format(time.RFC3339Nano), "created_at": createdAt,
	})
}

func (h *Handler) ListShares(w http.ResponseWriter, r *http.Request) {
	fileID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	userID := auth.UserID(r)
	var memberCount int
	err = h.DB.QueryRow(`SELECT COUNT(*) FROM files f JOIN messages m ON m.id=f.message_id
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
		WHERE f.id=? AND cm.user_id=? AND cm.role<>'pending' AND m.created_at>=cm.created_at`, fileID, userID).Scan(&memberCount)
	if err != nil || memberCount != 1 {
		httpx.Error(w, http.StatusNotFound, "file not found")
		return
	}
	rows, err := h.DB.Query(`SELECT id,expires_at,revoked_at,download_count,last_downloaded_at,created_at
		FROM file_shares WHERE file_id=? AND created_by=? ORDER BY id DESC`, fileID, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file share lookup failed")
		return
	}
	defer rows.Close()
	now := time.Now().UTC()
	result := make([]map[string]any, 0)
	for rows.Next() {
		var id, downloads int64
		var expiresAt, createdAt string
		var revokedAt, lastDownloaded sql.NullString
		if rows.Scan(&id, &expiresAt, &revokedAt, &downloads, &lastDownloaded, &createdAt) != nil {
			continue
		}
		deadline, _ := time.Parse(time.RFC3339Nano, expiresAt)
		result = append(result, map[string]any{
			"id": id, "expires_at": expiresAt, "revoked_at": nullableString(revokedAt),
			"download_count": downloads, "last_downloaded_at": nullableString(lastDownloaded),
			"created_at": createdAt, "active": !revokedAt.Valid && deadline.After(now),
		})
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) PublicShare(w http.ResponseWriter, r *http.Request) {
	share, status, err := h.publicShare(r.PathValue("token"), false)
	if err != nil {
		httpx.Error(w, status, err.Error())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{
		"encrypted_name":     share.EncryptedName,
		"encrypted_mime":     share.EncryptedMIME,
		"size":               share.Size,
		"expires_at":         share.ExpiresAt,
		"download_count":     share.DownloadCount,
		"last_downloaded_at": nullableString(share.LastDownloaded),
	})
}

func (h *Handler) DownloadShare(w http.ResponseWriter, r *http.Request) {
	share, status, err := h.publicShare(r.PathValue("token"), true)
	if err != nil {
		httpx.Error(w, status, err.Error())
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE file_shares SET download_count=download_count+1,last_downloaded_at=?
		WHERE id=? AND revoked_at IS NULL AND expires_at>?`, now, share.ID, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file share download failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		httpx.Error(w, http.StatusGone, "file share unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, http.StatusOK, map[string]any{
		"encrypted_data": base64.StdEncoding.EncodeToString(share.EncryptedData), "iv": share.IV, "size": share.Size,
	})
}

func (h *Handler) DeleteShare(w http.ResponseWriter, r *http.Request) {
	shareID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE file_shares SET revoked_at=? WHERE id=? AND created_by=? AND revoked_at IS NULL`,
		now, shareID, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file share revocation failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		httpx.Error(w, http.StatusNotFound, "file share not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"revoked": true, "revoked_at": now})
}

func (h *Handler) DeleteFileShares(w http.ResponseWriter, r *http.Request) {
	fileID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE file_shares SET revoked_at=?
		WHERE file_id=? AND created_by=? AND revoked_at IS NULL AND expires_at>?`,
		now, fileID, auth.UserID(r), now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file share revocation failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "file share not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"revoked": true, "revoked_count": affected, "revoked_at": now,
	})
}

func (h *Handler) publicShare(token string, includeData bool) (publicShare, int, error) {
	if !validShareToken(token) {
		return publicShare{}, http.StatusNotFound, shareError("file share not found")
	}
	hash := shareTokenHash(token)
	columns := `id,encrypted_name,encrypted_mime,NULL,iv,size,expires_at,revoked_at,download_count,last_downloaded_at`
	if includeData {
		columns = `id,encrypted_name,encrypted_mime,encrypted_data,iv,size,expires_at,revoked_at,download_count,last_downloaded_at`
	}
	var share publicShare
	err := h.DB.QueryRow(`SELECT `+columns+` FROM file_shares WHERE token_hash=?`, hash).Scan(
		&share.ID, &share.EncryptedName, &share.EncryptedMIME, &share.EncryptedData, &share.IV, &share.Size,
		&share.ExpiresAt, &share.RevokedAt, &share.DownloadCount, &share.LastDownloaded)
	if err == sql.ErrNoRows {
		return publicShare{}, http.StatusNotFound, shareError("file share not found")
	}
	if err != nil {
		return publicShare{}, http.StatusInternalServerError, shareError("file share lookup failed")
	}
	deadline, parseErr := time.Parse(time.RFC3339Nano, share.ExpiresAt)
	if share.RevokedAt.Valid || parseErr != nil || !deadline.After(time.Now().UTC()) {
		return publicShare{}, http.StatusGone, shareError("file share unavailable")
	}
	return share, http.StatusOK, nil
}

type shareError string

func (e shareError) Error() string { return string(e) }

func fileShareExpiry(seconds int64) (time.Time, bool) {
	switch seconds {
	case 3600, 86400, 604800, 2592000:
		return time.Now().UTC().Add(time.Duration(seconds) * time.Second), true
	default:
		return time.Time{}, false
	}
}

func newShareToken() (string, string, error) {
	bytes := make([]byte, shareTokenBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", "", err
	}
	token := base64.RawURLEncoding.EncodeToString(bytes)
	return token, shareTokenHash(token), nil
}

func validShareToken(token string) bool {
	if len(strings.TrimSpace(token)) != 43 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(decoded) == shareTokenBytes
}

func shareTokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func nullableString(value sql.NullString) any {
	if value.Valid {
		return value.String
	}
	return nil
}
