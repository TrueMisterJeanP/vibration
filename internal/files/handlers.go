package files

import (
	"database/sql"
	"encoding/base64"
	"net/http"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
)

const maxFileSize = 10 << 20

type Broadcaster interface {
	SendToUser(userID int64, event any) bool
}

type PushSender interface {
	NotifyUser(userID int64)
}

type Handler struct {
	DB   *sql.DB
	Hub  Broadcaster
	Push PushSender
}

func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	var input struct {
		ConversationID   int64  `json:"conversation_id"`
		EncryptedName    string `json:"encrypted_name"`
		EncryptedMIME    string `json:"encrypted_mime"`
		EncryptedData    string `json:"encrypted_data"`
		IV               string `json:"iv"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	userID := auth.UserID(r)
	if !h.isMember(input.ConversationID, userID) || len(input.EncryptedName) < 10 || len(input.EncryptedName) > 4096 ||
		len(input.EncryptedMIME) < 10 || len(input.EncryptedMIME) > 4096 || len(input.IV) < 8 || len(input.IV) > 128 {
		httpx.Error(w, http.StatusBadRequest, "invalid encrypted file")
		return
	}
	var federated int
	if h.DB.QueryRow(`SELECT COUNT(*) FROM federated_conversations WHERE local_conversation_id=?`, input.ConversationID).Scan(&federated) == nil && federated > 0 {
		httpx.Error(w, http.StatusConflict, "federated files are not supported")
		return
	}
	expiresAt, validExpiry := expiryTime(input.ExpiresInSeconds)
	if !validExpiry {
		httpx.Error(w, http.StatusBadRequest, "invalid message expiration")
		return
	}
	data, err := base64.StdEncoding.DecodeString(input.EncryptedData)
	if err != nil || len(data) == 0 || len(data) > maxFileSize+64 {
		httpx.Error(w, http.StatusRequestEntityTooLarge, "encrypted file exceeds 10 MB")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "upload failed")
		return
	}
	defer tx.Rollback()
	messageResult, err := tx.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,expires_at,created_at) VALUES(?,?,NULL,?,?,?)`,
		input.ConversationID, userID, input.IV, expiresAt, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message creation failed")
		return
	}
	messageID, _ := messageResult.LastInsertId()
	fileResult, err := tx.Exec(`INSERT INTO files(message_id,owner_id,encrypted_name,encrypted_mime,encrypted_data,iv,size,created_at)
		VALUES(?,?,?,?,?,?,?,?)`, messageID, userID, input.EncryptedName, input.EncryptedMIME, data, input.IV, len(data), now)
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
	fileMeta := map[string]any{"id": fileID, "encrypted_name": input.EncryptedName, "encrypted_mime": input.EncryptedMIME, "iv": input.IV, "size": len(data)}
	message := map[string]any{"id": messageID, "conversation_id": input.ConversationID, "sender_id": userID,
		"sender_username": username, "sender_avatar": avatar, "encrypted_content": nil, "iv": input.IV, "expires_at": expiresAt, "created_at": now, "status": "sent", "file": fileMeta}
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
		}
		if h.Hub != nil {
			h.Hub.SendToUser(id, map[string]any{"type": "conversation_updated", "conversation_id": input.ConversationID})
		}
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
