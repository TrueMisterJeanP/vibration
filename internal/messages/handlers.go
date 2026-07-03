package messages

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
)

type Broadcaster interface {
	SendToUser(userID int64, event any) bool
}

type PushSender interface {
	NotifyUser(userID int64)
}

type FederationRouter interface {
	QueueMessage(message Message)
}

type Handler struct {
	DB         *sql.DB
	Hub        Broadcaster
	Push       PushSender
	Federation FederationRouter
}

type Message struct {
	ID               int64      `json:"id"`
	ConversationID   int64      `json:"conversation_id"`
	SenderID         int64      `json:"sender_id"`
	SenderUsername   string     `json:"sender_username"`
	SenderAvatar     *string    `json:"sender_avatar"`
	EncryptedContent *string    `json:"encrypted_content"`
	IV               string     `json:"iv"`
	ReplyTo          *int64     `json:"reply_to"`
	ExpiresAt        *string    `json:"expires_at"`
	IsPinned         bool       `json:"is_pinned"`
	PinnedBy         *int64     `json:"pinned_by"`
	PinnedAt         *string    `json:"pinned_at"`
	CreatedAt        string     `json:"created_at"`
	UpdatedAt        *string    `json:"updated_at"`
	File             *File      `json:"file,omitempty"`
	Reactions        []Reaction `json:"reactions,omitempty"`
	Status           string     `json:"status"`
}

type Reaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Mine  bool   `json:"mine"`
}

type File struct {
	ID            int64  `json:"id"`
	EncryptedName string `json:"encrypted_name"`
	EncryptedMIME string `json:"encrypted_mime"`
	IV            string `json:"iv"`
	Size          int64  `json:"size"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	if err != nil || !h.isMember(conversationID, auth.UserID(r)) {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	if before <= 0 {
		before = 1<<63 - 1
	}
	h.deleteExpired(conversationID)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	rows, err := h.DB.Query(`SELECT m.id,m.conversation_id,m.sender_id,COALESCE(u.remote_username,u.username),u.avatar,m.encrypted_content,m.iv,m.reply_to,m.expires_at,m.pinned_by,m.pinned_at,m.created_at,m.updated_at,
		f.id,f.encrypted_name,f.encrypted_mime,f.iv,f.size,
		CASE
			WHEN NOT EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id=m.id AND mr.user_id<>m.sender_id AND mr.status<>'read') THEN 'read'
			WHEN NOT EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id=m.id AND mr.user_id<>m.sender_id AND mr.status='sent') THEN 'delivered'
			ELSE 'sent'
		END
		FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN files f ON f.message_id=m.id
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? AND cm.role<>'pending'
		WHERE m.conversation_id=? AND m.id<? AND m.created_at>=cm.created_at AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.id DESC LIMIT ?`,
		auth.UserID(r), conversationID, before, now, limit)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message lookup failed")
		return
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var item Message
		var fileID, pinnedBy sql.NullInt64
		var fileName, fileMIME, fileIV, expiresAt, pinnedAt sql.NullString
		var fileSize sql.NullInt64
		if rows.Scan(&item.ID, &item.ConversationID, &item.SenderID, &item.SenderUsername, &item.SenderAvatar, &item.EncryptedContent, &item.IV,
			&item.ReplyTo, &expiresAt, &pinnedBy, &pinnedAt, &item.CreatedAt, &item.UpdatedAt, &fileID, &fileName, &fileMIME, &fileIV, &fileSize, &item.Status) == nil {
			if expiresAt.Valid {
				item.ExpiresAt = &expiresAt.String
			}
			if pinnedBy.Valid && pinnedAt.Valid {
				item.IsPinned = true
				item.PinnedBy = &pinnedBy.Int64
				item.PinnedAt = &pinnedAt.String
			}
			if fileID.Valid {
				item.File = &File{ID: fileID.Int64, EncryptedName: fileName.String, EncryptedMIME: fileMIME.String, IV: fileIV.String, Size: fileSize.Int64}
			}
			result = append(result, item)
		}
	}
	h.attachReactions(result, auth.UserID(r))
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	userID := auth.UserID(r)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	var input struct {
		EncryptedContent string `json:"encrypted_content"`
		IV               string `json:"iv"`
		ReplyTo          *int64 `json:"reply_to"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if len(input.EncryptedContent) < 1 || len(input.EncryptedContent) > 1<<20 || len(input.IV) < 8 || len(input.IV) > 128 {
		httpx.Error(w, http.StatusBadRequest, "invalid encrypted message")
		return
	}
	expiresAt, validExpiry := expiryTime(input.ExpiresInSeconds)
	if !validExpiry {
		httpx.Error(w, http.StatusBadRequest, "invalid message expiration")
		return
	}
	message, err := h.insert(conversationID, userID, &input.EncryptedContent, input.IV, input.ReplyTo, expiresAt)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message creation failed")
		return
	}
	h.broadcast(message)
	if h.Federation != nil {
		h.Federation.QueueMessage(message)
	}
	httpx.JSON(w, http.StatusCreated, message)
}

func (h *Handler) insert(conversationID, userID int64, content *string, iv string, replyTo *int64, expiresAt *string) (Message, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := h.DB.Begin()
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	result, err := tx.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,reply_to,expires_at,created_at) VALUES(?,?,?,?,?,?,?)`,
		conversationID, userID, content, iv, replyTo, expiresAt, now)
	if err != nil {
		return Message{}, err
	}
	id, _ := result.LastInsertId()
	rows, err := tx.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND role<>'pending'`, conversationID)
	if err != nil {
		return Message{}, err
	}
	var members []int64
	for rows.Next() {
		var memberID int64
		if rows.Scan(&memberID) == nil {
			members = append(members, memberID)
		}
	}
	rows.Close()
	for _, memberID := range members {
		status := "sent"
		if memberID == userID {
			status = "read"
		}
		if _, err := tx.Exec(`INSERT INTO message_receipts(message_id,user_id,status,created_at) VALUES(?,?,?,?)`, id, memberID, status, now); err != nil {
			return Message{}, err
		}
	}
	var username string
	var avatar *string
	if err := tx.QueryRow(`SELECT COALESCE(remote_username,username),avatar FROM users WHERE id=?`, userID).Scan(&username, &avatar); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return Message{ID: id, ConversationID: conversationID, SenderID: userID, SenderUsername: username,
		SenderAvatar: avatar, EncryptedContent: content, IV: iv, ReplyTo: replyTo, ExpiresAt: expiresAt, CreatedAt: now, Status: "sent"}, nil
}

func (h *Handler) Read(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	userID := auth.UserID(r)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var conversationID, senderID int64
	if err := h.DB.QueryRow(`SELECT conversation_id,sender_id FROM messages WHERE id=?`, messageID).Scan(&conversationID, &senderID); err != nil ||
		!h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	result, err := h.DB.Exec(`UPDATE message_receipts SET status='read',created_at=? WHERE message_id=? AND user_id=?`, now, messageID, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "receipt update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if h.Hub != nil {
		h.Hub.SendToUser(senderID, map[string]any{"type": "message_read", "message_id": messageID, "conversation_id": conversationID, "user_id": userID})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		EncryptedContent string `json:"encrypted_content"`
		IV               string `json:"iv"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if len(input.EncryptedContent) < 1 || len(input.EncryptedContent) > 1<<20 || len(input.IV) < 8 || len(input.IV) > 128 {
		httpx.Error(w, http.StatusBadRequest, "invalid encrypted message")
		return
	}
	var conversationID int64
	if err := h.DB.QueryRow(`SELECT conversation_id FROM messages WHERE id=? AND sender_id=?`, messageID, auth.UserID(r)).Scan(&conversationID); err != nil {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if !h.isMember(conversationID, auth.UserID(r)) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if h.isFederatedConversation(conversationID) {
		httpx.Error(w, http.StatusConflict, "federated message updates are not supported")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE messages SET encrypted_content=?,iv=?,updated_at=?
		WHERE id=? AND sender_id=? AND NOT EXISTS(SELECT 1 FROM files WHERE message_id=messages.id)`,
		input.EncryptedContent, input.IV, now, messageID, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "conversation_updated", "conversation_id": conversationID, "updated_message_id": messageID,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "updated_at": now})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var conversationID int64
	err = h.DB.QueryRow(`SELECT conversation_id FROM messages WHERE id=? AND sender_id=?`, messageID, auth.UserID(r)).Scan(&conversationID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if !h.isMember(conversationID, auth.UserID(r)) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if h.isFederatedConversation(conversationID) {
		httpx.Error(w, http.StatusConflict, "federated message updates are not supported")
		return
	}
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE messages SET reply_to=NULL WHERE reply_to=?`, messageID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	result, err := tx.Exec(`DELETE FROM messages WHERE id=?`, messageID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "message_deleted", "conversation_id": conversationID, "message_id": messageID,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) React(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		Emoji string `json:"emoji"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	emoji := strings.TrimSpace(input.Emoji)
	if len([]rune(emoji)) < 1 || len([]rune(emoji)) > 16 {
		httpx.Error(w, http.StatusBadRequest, "invalid reaction")
		return
	}
	userID := auth.UserID(r)
	var conversationID int64
	now := time.Now().UTC().Format(time.RFC3339Nano)
	err = h.DB.QueryRow(`SELECT conversation_id FROM messages WHERE id=? AND (expires_at IS NULL OR expires_at>?)`, messageID, now).Scan(&conversationID)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	var existing int
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?`, messageID, userID, emoji).Scan(&existing); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "reaction update failed")
		return
	}
	if existing > 0 {
		if _, err := h.DB.Exec(`DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?`, messageID, userID, emoji); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "reaction update failed")
			return
		}
	} else if _, err := h.DB.Exec(`INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)`, messageID, userID, emoji, now); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "reaction update failed")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "conversation_updated", "conversation_id": conversationID, "reaction_message_id": messageID,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "active": existing == 0})
}

func (h *Handler) Pin(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		Pinned bool `json:"pinned"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	userID := auth.UserID(r)
	var conversationID int64
	now := time.Now().UTC().Format(time.RFC3339Nano)
	err = h.DB.QueryRow(`SELECT conversation_id FROM messages WHERE id=? AND (expires_at IS NULL OR expires_at>?)`, messageID, now).Scan(&conversationID)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if input.Pinned {
		_, err = h.DB.Exec(`UPDATE messages SET pinned_by=?,pinned_at=? WHERE id=?`, userID, now, messageID)
	} else {
		_, err = h.DB.Exec(`UPDATE messages SET pinned_by=NULL,pinned_at=NULL WHERE id=?`, messageID)
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message pin update failed")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "conversation_updated", "conversation_id": conversationID, "pinned_message_id": messageID,
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) isMember(conversationID, userID int64) bool {
	var count int
	return h.DB.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=? AND role<>'pending'`, conversationID, userID).
		Scan(&count) == nil && count == 1
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

func (h *Handler) deleteExpired(conversationID int64) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = h.DB.Exec(`DELETE FROM messages WHERE conversation_id=? AND expires_at IS NOT NULL AND expires_at<=?`, conversationID, now)
}

func (h *Handler) attachReactions(messages []Message, userID int64) {
	for index := range messages {
		rows, err := h.DB.Query(`SELECT emoji,COUNT(*),SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END)
			FROM message_reactions WHERE message_id=? GROUP BY emoji ORDER BY MIN(created_at)`, userID, messages[index].ID)
		if err != nil {
			continue
		}
		for rows.Next() {
			var reaction Reaction
			var mineCount int
			if rows.Scan(&reaction.Emoji, &reaction.Count, &mineCount) == nil {
				reaction.Mine = mineCount > 0
				messages[index].Reactions = append(messages[index].Reactions, reaction)
			}
		}
		rows.Close()
	}
}

func (h *Handler) isFederatedConversation(conversationID int64) bool {
	var count int
	return h.DB.QueryRow(`SELECT COUNT(*) FROM federated_conversations WHERE local_conversation_id=?`, conversationID).
		Scan(&count) == nil && count > 0
}

func (h *Handler) broadcast(message Message) {
	rows, err := h.DB.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND role<>'pending'`, message.ConversationID)
	if err != nil {
		return
	}
	var recipients []int64
	for rows.Next() {
		var userID int64
		if rows.Scan(&userID) == nil && userID != message.SenderID {
			recipients = append(recipients, userID)
		}
	}
	rows.Close()
	for _, userID := range recipients {
		online := h.Hub != nil && h.Hub.SendToUser(userID, map[string]any{"type": "new_message", "message": message})
		if online {
			now := time.Now().UTC().Format(time.RFC3339Nano)
			_, _ = h.DB.Exec(`UPDATE message_receipts SET status='delivered',created_at=? WHERE message_id=? AND user_id=?`, now, message.ID, userID)
			if h.Hub != nil {
				h.Hub.SendToUser(message.SenderID, map[string]any{"type": "message_delivered", "message_id": message.ID, "conversation_id": message.ConversationID, "user_id": userID})
			}
		}
		if h.Push != nil {
			go h.Push.NotifyUser(userID)
		}
	}
	h.broadcastEvent(message.ConversationID, map[string]any{"type": "conversation_updated", "conversation_id": message.ConversationID})
}

func (h *Handler) broadcastEvent(conversationID int64, event any) {
	rows, err := h.DB.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND role<>'pending'`, conversationID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var userID int64
		if rows.Scan(&userID) == nil && h.Hub != nil {
			h.Hub.SendToUser(userID, event)
		}
	}
}
