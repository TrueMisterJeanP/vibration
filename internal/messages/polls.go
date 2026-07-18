package messages

import (
	"net/http"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
)

const (
	minPollOptions = 2
	maxPollOptions = 10
)

func (h *Handler) CreatePoll(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	userID := auth.UserID(r)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	var input struct {
		EncryptedContent string `json:"encrypted_content"`
		IV               string `json:"iv"`
		OptionCount      int    `json:"option_count"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if !validPollPayload(input.EncryptedContent, input.IV, input.OptionCount) {
		httpx.Error(w, http.StatusBadRequest, "invalid poll")
		return
	}
	pollExpiresAt, validExpiry := expiryTime(input.ExpiresInSeconds)
	if !validExpiry {
		httpx.Error(w, http.StatusBadRequest, "invalid poll expiration")
		return
	}
	message, err := h.insert(conversationID, userID, &input.EncryptedContent, input.IV, nil, nil, pollExpiresAt, input.OptionCount, nil)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "poll creation failed")
		return
	}
	h.broadcast(message)
	if h.Federation != nil {
		h.Federation.QueueMessage(message)
	}
	httpx.JSON(w, http.StatusCreated, message)
}

func (h *Handler) UpdatePoll(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		EncryptedContent string `json:"encrypted_content"`
		IV               string `json:"iv"`
		OptionCount      int    `json:"option_count"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if !validPollPayload(input.EncryptedContent, input.IV, input.OptionCount) {
		httpx.Error(w, http.StatusBadRequest, "invalid poll")
		return
	}
	pollExpiresAt, validExpiry := expiryTime(input.ExpiresInSeconds)
	if !validExpiry {
		httpx.Error(w, http.StatusBadRequest, "invalid poll expiration")
		return
	}
	userID := auth.UserID(r)
	var conversationID int64
	err = h.DB.QueryRow(`SELECT m.conversation_id FROM messages m
		WHERE m.id=? AND m.sender_id=? AND EXISTS(SELECT 1 FROM poll_options po WHERE po.message_id=m.id)`, messageID, userID).Scan(&conversationID)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "poll not found")
		return
	}
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "poll update failed")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM poll_options WHERE message_id=?`, messageID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "poll update failed")
		return
	}
	for position := 0; position < input.OptionCount; position++ {
		if _, err := tx.Exec(`INSERT INTO poll_options(message_id,position) VALUES(?,?)`, messageID, position); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "poll update failed")
			return
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.Exec(`UPDATE messages SET encrypted_content=?,iv=?,poll_expires_at=?,updated_at=? WHERE id=? AND sender_id=?`,
		input.EncryptedContent, input.IV, pollExpiresAt, now, messageID, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "poll update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		httpx.Error(w, http.StatusNotFound, "poll not found")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "poll update failed")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "conversation_updated", "conversation_id": conversationID, "poll_message_id": messageID,
	})
	if h.Federation != nil {
		h.Federation.QueuePollUpdate(messageID, input.EncryptedContent, input.IV, input.OptionCount, pollExpiresAt)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "updated_at": now, "expires_at": pollExpiresAt, "votes_reset": true})
}

func (h *Handler) VotePoll(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		OptionID int64 `json:"option_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	userID := auth.UserID(r)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var conversationID int64
	var optionPosition int
	var expiresAt *string
	err = h.DB.QueryRow(`SELECT m.conversation_id,po.position,m.poll_expires_at FROM messages m JOIN poll_options po ON po.message_id=m.id
		WHERE m.id=? AND po.id=?`, messageID, input.OptionID).Scan(&conversationID, &optionPosition, &expiresAt)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "poll not found")
		return
	}
	if expiresAt != nil && pollExpired(*expiresAt, time.Now().UTC()) {
		httpx.Error(w, http.StatusGone, "poll expired")
		return
	}
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "poll vote failed")
		return
	}
	defer tx.Rollback()
	var existing int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM poll_votes WHERE message_id=? AND user_id=?`, messageID, userID).Scan(&existing); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "poll vote failed")
		return
	}
	if existing > 0 {
		httpx.Error(w, http.StatusConflict, "poll already voted")
		return
	}
	if _, err := tx.Exec(`INSERT INTO poll_votes(message_id,option_id,user_id,created_at) VALUES(?,?,?,?)`, messageID, input.OptionID, userID, now); err != nil {
		httpx.Error(w, http.StatusConflict, "poll already voted")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "poll vote failed")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "conversation_updated", "conversation_id": conversationID, "poll_message_id": messageID,
	})
	if h.Federation != nil {
		h.Federation.QueuePollVote(messageID, userID, optionPosition, now)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func pollExpired(expiresAt string, now time.Time) bool {
	deadline, err := time.Parse(time.RFC3339Nano, expiresAt)
	return err != nil || !deadline.After(now)
}

func validPollPayload(content, iv string, optionCount int) bool {
	return len(content) >= 1 && len(content) <= 1<<20 && len(iv) >= 8 && len(iv) <= 128 &&
		optionCount >= minPollOptions && optionCount <= maxPollOptions
}
