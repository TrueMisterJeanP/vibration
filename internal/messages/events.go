package messages

import (
	"net/http"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
)

type eventInput struct {
	EncryptedContent string `json:"encrypted_content"`
	IV               string `json:"iv"`
	StartsAt         string `json:"starts_at"`
	EndsAt           string `json:"ends_at"`
}

func (h *Handler) CreateEvent(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	userID := auth.UserID(r)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	var input eventInput
	if !httpx.Decode(w, r, &input) {
		return
	}
	if !validEventInput(input) {
		httpx.Error(w, http.StatusBadRequest, "invalid event")
		return
	}
	event := &Event{StartsAt: input.StartsAt, EndsAt: input.EndsAt}
	message, err := h.insert(conversationID, userID, &input.EncryptedContent, input.IV, nil, nil, nil, 0, event)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "event creation failed")
		return
	}
	h.broadcast(message)
	if h.Federation != nil {
		h.Federation.QueueMessage(message)
	}
	httpx.JSON(w, http.StatusCreated, message)
}

func (h *Handler) UpdateEvent(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input eventInput
	if !httpx.Decode(w, r, &input) {
		return
	}
	if !validEventInput(input) {
		httpx.Error(w, http.StatusBadRequest, "invalid event")
		return
	}
	userID := auth.UserID(r)
	var conversationID int64
	if err := h.DB.QueryRow(`SELECT m.conversation_id FROM messages m JOIN message_events e ON e.message_id=m.id
		WHERE m.id=? AND m.sender_id=?`, messageID, userID).Scan(&conversationID); err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "event not found")
		return
	}
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "event update failed")
		return
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.Exec(`UPDATE messages SET encrypted_content=?,iv=?,updated_at=? WHERE id=? AND sender_id=?`,
		input.EncryptedContent, input.IV, now, messageID, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "event update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		httpx.Error(w, http.StatusNotFound, "event not found")
		return
	}
	if _, err := tx.Exec(`UPDATE message_events SET starts_at=?,ends_at=? WHERE message_id=?`, input.StartsAt, input.EndsAt, messageID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "event update failed")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "event update failed")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "conversation_updated", "conversation_id": conversationID, "event_message_id": messageID,
	})
	if h.Federation != nil {
		h.Federation.QueueEventUpdate(messageID, input.EncryptedContent, input.IV, input.StartsAt, input.EndsAt)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "updated_at": now})
}

func (h *Handler) ListEvents(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r)
	rows, err := h.DB.Query(`SELECT m.id,m.conversation_id,m.sender_id,COALESCE(u.remote_username,u.username),u.avatar,
		m.encrypted_content,m.iv,m.created_at,m.updated_at,e.starts_at,e.ends_at
		FROM message_events e JOIN messages m ON m.id=e.message_id JOIN users u ON u.id=m.sender_id
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? AND cm.role<>'pending'
		WHERE m.created_at>=cm.created_at ORDER BY e.starts_at,e.ends_at,m.id`, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "event lookup failed")
		return
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var message Message
		var event Event
		if rows.Scan(&message.ID, &message.ConversationID, &message.SenderID, &message.SenderUsername, &message.SenderAvatar,
			&message.EncryptedContent, &message.IV, &message.CreatedAt, &message.UpdatedAt, &event.StartsAt, &event.EndsAt) == nil {
			message.Event = &event
			result = append(result, message)
		}
	}
	httpx.JSON(w, http.StatusOK, result)
}

func validEventInput(input eventInput) bool {
	if len(input.EncryptedContent) < 1 || len(input.EncryptedContent) > 1<<20 || len(input.IV) < 8 || len(input.IV) > 128 ||
		len(input.StartsAt) > 64 || len(input.EndsAt) > 64 {
		return false
	}
	start, startErr := time.Parse(time.RFC3339Nano, input.StartsAt)
	end, endErr := time.Parse(time.RFC3339Nano, input.EndsAt)
	return startErr == nil && endErr == nil && end.After(start)
}
