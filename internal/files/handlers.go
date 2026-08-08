package files

import (
	"database/sql"
	"encoding/base64"
	"net/http"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/groupkeys"
	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/settings"
)

const (
	maxFileSize            = settings.DefaultMaxFileSize
	maxFilePreviewSize     = 512 << 10
	maxFileRequestBodySize = 36 << 20
	fileEncryptionOverhead = 64
)

type Broadcaster interface {
	SendToUser(userID int64, event any) bool
}

type PushSender interface {
	NotifyUser(userID int64)
}

type FederationRouter interface {
	QueueFile(messageID int64)
}

type Handler struct {
	DB         *sql.DB
	Hub        Broadcaster
	Push       PushSender
	Federation FederationRouter
}

type listedFile struct {
	ID               int64  `json:"id"`
	EncryptedName    string `json:"encrypted_name"`
	EncryptedMIME    string `json:"encrypted_mime"`
	IV               string `json:"iv"`
	Size             int64  `json:"size"`
	HasPreview       bool   `json:"has_preview"`
	PreviewSize      int64  `json:"preview_size,omitempty"`
	ActiveShareCount int64  `json:"active_share_count"`
}

type listedFileMessage struct {
	ID               int64       `json:"id"`
	ConversationID   int64       `json:"conversation_id"`
	SenderID         int64       `json:"sender_id"`
	SenderUsername   string      `json:"sender_username"`
	SenderAvatar     *string     `json:"sender_avatar"`
	EncryptedContent *string     `json:"encrypted_content"`
	IV               string      `json:"iv"`
	KeyEpoch         int64       `json:"key_epoch"`
	ExpiresAt        *string     `json:"expires_at"`
	CreatedAt        string      `json:"created_at"`
	UpdatedAt        *string     `json:"updated_at"`
	File             *listedFile `json:"file"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	userID := auth.UserID(r)
	rows, err := h.DB.Query(`SELECT m.id,m.conversation_id,m.sender_id,COALESCE(u.remote_username,u.username),u.avatar,
		m.encrypted_content,m.iv,m.key_epoch,m.expires_at,m.created_at,m.updated_at,
		f.id,f.encrypted_name,f.encrypted_mime,f.iv,f.size,f.preview_size,
		(SELECT COUNT(*) FROM file_shares fs WHERE fs.file_id=f.id AND fs.created_by=?
			AND fs.revoked_at IS NULL AND fs.expires_at>?)
		FROM files f JOIN messages m ON m.id=f.message_id JOIN users u ON u.id=m.sender_id
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? AND cm.role<>'pending'
		WHERE m.created_at>=cm.created_at AND (m.expires_at IS NULL OR m.expires_at>?)
		ORDER BY m.created_at DESC,m.id DESC`, userID, now, userID, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file lookup failed")
		return
	}
	defer rows.Close()
	result := make([]listedFileMessage, 0)
	for rows.Next() {
		var message listedFileMessage
		var file listedFile
		var previewSize sql.NullInt64
		if rows.Scan(&message.ID, &message.ConversationID, &message.SenderID, &message.SenderUsername, &message.SenderAvatar,
			&message.EncryptedContent, &message.IV, &message.KeyEpoch, &message.ExpiresAt, &message.CreatedAt, &message.UpdatedAt,
			&file.ID, &file.EncryptedName, &file.EncryptedMIME, &file.IV, &file.Size, &previewSize, &file.ActiveShareCount) == nil {
			if previewSize.Valid && previewSize.Int64 > 0 {
				file.HasPreview = true
				file.PreviewSize = previewSize.Int64
			}
			message.File = &file
			result = append(result, message)
		}
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) UploadLimits(w http.ResponseWriter, r *http.Request) {
	quotas, err := settings.LoadFileQuotas(h.DB)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file quota lookup failed")
		return
	}
	used, err := fileUsage(h.DB, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file quota lookup failed")
		return
	}
	remaining := quotas.MaxUserStorage - used
	if remaining < 0 {
		remaining = 0
	}
	httpx.JSON(w, http.StatusOK, map[string]int64{
		"max_file_size":     quotas.MaxFileSize,
		"max_user_storage":  quotas.MaxUserStorage,
		"used_storage":      used,
		"remaining_storage": remaining,
	})
}

func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ConversationID   int64  `json:"conversation_id"`
		EncryptedName    string `json:"encrypted_name"`
		EncryptedMIME    string `json:"encrypted_mime"`
		EncryptedData    string `json:"encrypted_data"`
		IV               string `json:"iv"`
		EncryptedPreview string `json:"encrypted_preview_data"`
		PreviewIV        string `json:"preview_iv"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
		KeyEpoch         int64  `json:"key_epoch"`
	}
	quotas, err := settings.LoadFileQuotas(h.DB)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file quota lookup failed")
		return
	}
	if !httpx.DecodeWithLimit(w, r, &input, fileRequestBodyLimit(quotas.MaxFileSize)) {
		return
	}
	userID := auth.UserID(r)
	if !h.isMember(input.ConversationID, userID) || len(input.EncryptedName) < 10 || len(input.EncryptedName) > 4096 ||
		len(input.EncryptedMIME) < 10 || len(input.EncryptedMIME) > 4096 || len(input.IV) < 8 || len(input.IV) > 128 {
		httpx.Error(w, http.StatusBadRequest, "invalid encrypted file")
		return
	}
	expiresAt, validExpiry := expiryTime(input.ExpiresInSeconds)
	if !validExpiry {
		httpx.Error(w, http.StatusBadRequest, "invalid message expiration")
		return
	}
	data, err := base64.StdEncoding.DecodeString(input.EncryptedData)
	if err != nil || len(data) == 0 || int64(len(data)) > storedFileSizeLimit(quotas.MaxFileSize) {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "file exceeds configured size limit")
		return
	}
	var previewData []byte
	if input.EncryptedPreview != "" || input.PreviewIV != "" {
		if input.EncryptedPreview == "" || len(input.PreviewIV) < 8 || len(input.PreviewIV) > 128 {
			httpx.Error(w, http.StatusBadRequest, "invalid encrypted file preview")
			return
		}
		previewData, err = base64.StdEncoding.DecodeString(input.EncryptedPreview)
		if err != nil || len(previewData) == 0 || len(previewData) > maxFilePreviewSize+64 {
			httpx.Error(w, http.StatusRequestEntityTooLarge, "encrypted file preview exceeds 512 KB")
			return
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "upload failed")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE users SET id=id WHERE id=?`, userID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "upload failed")
		return
	}
	input.KeyEpoch, err = groupkeys.ValidateSend(tx, input.ConversationID, userID, input.KeyEpoch)
	if err != nil {
		status := http.StatusInternalServerError
		if err == groupkeys.ErrNotMember {
			status = http.StatusNotFound
		} else if err == groupkeys.ErrRotationRequired || err == groupkeys.ErrStaleEpoch {
			status = http.StatusConflict
		}
		httpx.Error(w, status, err.Error())
		return
	}
	quotas, err = settings.LoadFileQuotas(tx)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file quota lookup failed")
		return
	}
	if int64(len(data)) > storedFileSizeLimit(quotas.MaxFileSize) {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "file exceeds configured size limit")
		return
	}
	used, err := fileUsage(tx, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file quota lookup failed")
		return
	}
	if used > quotas.MaxUserStorage || int64(len(data)) > quotas.MaxUserStorage-used {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "user file quota exceeded")
		return
	}
	messageResult, err := tx.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,key_epoch,expires_at,created_at) VALUES(?,?,NULL,?,?,?,?)`,
		input.ConversationID, userID, input.IV, input.KeyEpoch, expiresAt, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message creation failed")
		return
	}
	messageID, _ := messageResult.LastInsertId()
	fileResult, err := tx.Exec(`INSERT INTO files(message_id,owner_id,encrypted_name,encrypted_mime,encrypted_data,iv,size,encrypted_preview_data,preview_iv,preview_size,created_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?)`, messageID, userID, input.EncryptedName, input.EncryptedMIME, data, input.IV, len(data), nullablePreviewBytes(previewData), nullablePreviewString(input.PreviewIV), nullablePreviewSize(previewData), now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "file storage failed")
		return
	}
	fileID, _ := fileResult.LastInsertId()
	rows, err := tx.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND role<>'pending'`, input.ConversationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "receipt creation failed")
		return
	}
	var members []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			members = append(members, id)
		}
	}
	rows.Close()
	for _, id := range members {
		status := "sent"
		if id == userID {
			status = "read"
		}
		if _, err := tx.Exec(`INSERT INTO message_receipts(message_id,user_id,status,created_at) VALUES(?,?,?,?)`, messageID, id, status, now); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "receipt creation failed")
			return
		}
	}
	var username string
	var avatar *string
	_ = tx.QueryRow(`SELECT COALESCE(remote_username,username),avatar FROM users WHERE id=?`, userID).Scan(&username, &avatar)
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "upload commit failed")
		return
	}
	fileMeta := map[string]any{"id": fileID, "encrypted_name": input.EncryptedName, "encrypted_mime": input.EncryptedMIME, "iv": input.IV, "size": len(data),
		"has_preview": len(previewData) > 0, "preview_size": len(previewData)}
	message := map[string]any{"id": messageID, "conversation_id": input.ConversationID, "sender_id": userID,
		"sender_username": username, "sender_avatar": avatar, "encrypted_content": nil, "iv": input.IV, "key_epoch": input.KeyEpoch, "expires_at": expiresAt, "created_at": now, "status": "sent", "file": fileMeta}
	personalConversation := len(members) == 1 && members[0] == userID
	for _, id := range members {
		if id != userID {
			online := h.Hub != nil && h.Hub.SendToUser(id, map[string]any{"type": "new_message", "message": message})
			if online {
				deliveredAt := time.Now().UTC().Format(time.RFC3339Nano)
				_, _ = h.DB.Exec(`UPDATE message_receipts SET status='delivered',created_at=? WHERE message_id=? AND user_id=?`, deliveredAt, messageID, id)
				if h.Hub != nil {
					h.Hub.SendToUser(userID, map[string]any{"type": "message_delivered", "message_id": messageID, "conversation_id": input.ConversationID, "user_id": id})
				}
			}
			if h.Push != nil {
				go h.Push.NotifyUser(id)
			}
		} else if personalConversation && h.Hub != nil {
			h.Hub.SendToUser(id, map[string]any{"type": "new_message", "message": message})
		}
		if h.Hub != nil {
			h.Hub.SendToUser(id, map[string]any{"type": "conversation_updated", "conversation_id": input.ConversationID})
		}
	}
	if h.Federation != nil {
		h.Federation.QueueFile(messageID)
	}
	httpx.JSON(w, http.StatusCreated, message)
}

func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	fileID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var name, mime, iv string
	var data []byte
	var size int64
	now := time.Now().UTC().Format(time.RFC3339Nano)
	err = h.DB.QueryRow(`SELECT f.encrypted_name,f.encrypted_mime,f.encrypted_data,f.iv,f.size
		FROM files f JOIN messages m ON m.id=f.message_id JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
		WHERE f.id=? AND cm.user_id=? AND cm.role<>'pending' AND m.created_at>=cm.created_at AND (m.expires_at IS NULL OR m.expires_at>?)`, fileID, auth.UserID(r), now).Scan(&name, &mime, &data, &iv, &size)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "file not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": fileID, "encrypted_name": name, "encrypted_mime": mime,
		"encrypted_data": base64.StdEncoding.EncodeToString(data), "iv": iv, "size": size,
	})
}

func (h *Handler) Preview(w http.ResponseWriter, r *http.Request) {
	fileID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var data []byte
	var iv string
	var size int64
	now := time.Now().UTC().Format(time.RFC3339Nano)
	err = h.DB.QueryRow(`SELECT f.encrypted_preview_data,f.preview_iv,f.preview_size
		FROM files f JOIN messages m ON m.id=f.message_id JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
		WHERE f.id=? AND f.encrypted_preview_data IS NOT NULL AND cm.user_id=? AND cm.role<>'pending'
		AND m.created_at>=cm.created_at AND (m.expires_at IS NULL OR m.expires_at>?)`, fileID, auth.UserID(r), now).Scan(&data, &iv, &size)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "file preview not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"id": fileID, "encrypted_data": base64.StdEncoding.EncodeToString(data), "iv": iv, "size": size,
	})
}

func nullablePreviewBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func nullablePreviewString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullablePreviewSize(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return len(value)
}

func expiryTime(seconds int64) (*string, bool) {
	if seconds == 0 {
		return nil, true
	}
	switch seconds {
	case 300, 3600, 86400, 604800:
		value := time.Now().UTC().Add(time.Duration(seconds) * time.Second).Format(time.RFC3339Nano)
		return &value, true
	default:
		return nil, false
	}
}

func (h *Handler) isMember(conversationID, userID int64) bool {
	var count int
	return conversationID > 0 && h.DB.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=? AND role<>'pending'`,
		conversationID, userID).Scan(&count) == nil && count == 1
}

type fileUsageQueryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

func fileUsage(db fileUsageQueryer, userID int64) (int64, error) {
	var used sql.NullInt64
	if err := db.QueryRow(`SELECT COALESCE(SUM(size),0) FROM files WHERE owner_id=?`, userID).Scan(&used); err != nil {
		return 0, err
	}
	if !used.Valid || used.Int64 < 0 {
		return 0, nil
	}
	return used.Int64, nil
}

func storedFileSizeLimit(maxFileSize int64) int64 {
	return maxFileSize + fileEncryptionOverhead
}

func fileRequestBodyLimit(maxFileSize int64) int64 {
	encodedFile := ((storedFileSizeLimit(maxFileSize) + 2) / 3) * 4
	encodedPreview := int64(((maxFilePreviewSize + fileEncryptionOverhead + 2) / 3) * 4)
	limit := encodedFile + encodedPreview + 128<<10
	if limit < maxFileRequestBodySize {
		return maxFileRequestBodySize
	}
	return limit
}
