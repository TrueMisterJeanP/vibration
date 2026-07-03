package messages

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

type sentEvent struct {
	userID int64
	event  any
}

type testHub struct {
	sent []sentEvent
}

func (h *testHub) SendToUser(userID int64, event any) bool {
	h.sent = append(h.sent, sentEvent{userID: userID, event: event})
	return true
}

type testPush struct {
	users chan int64
}

func (p *testPush) NotifyUser(userID int64) {
	p.users <- userID
}

func TestBroadcastNotifiesPushEvenWhenRecipientOnline(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	registerMessageUserNamed(t, authHandler, "online_sender", "Online Sender")
	registerMessageUserNamed(t, authHandler, "online_recipient", "Online Recipient")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	conversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('private',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := conversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'owner-key','owner',?),(?,2,'member-key','member',?)`, conversationID, now, conversationID, now); err != nil {
		t.Fatal(err)
	}
	messageResult, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,1,'encrypted','message-iv',?)`, conversationID, now)
	if err != nil {
		t.Fatal(err)
	}
	messageID, _ := messageResult.LastInsertId()
	if _, err := db.Exec(`INSERT INTO message_receipts(message_id,user_id,status,created_at) VALUES(?,2,'sent',?)`, messageID, now); err != nil {
		t.Fatal(err)
	}

	hub := &testHub{}
	push := &testPush{users: make(chan int64, 1)}
	handler := &Handler{DB: db, Hub: hub, Push: push}
	content := "encrypted"
	handler.broadcast(Message{ID: messageID, ConversationID: conversationID, SenderID: 1, EncryptedContent: &content, IV: "message-iv", CreatedAt: now})

	if !hasMessageEvent(hub.sent, 2, "new_message") || !hasMessageEvent(hub.sent, 1, "message_delivered") {
		t.Fatalf("missing websocket events: %#v", hub.sent)
	}
	var receiptStatus string
	if err := db.QueryRow(`SELECT status FROM message_receipts WHERE message_id=? AND user_id=2`, messageID).Scan(&receiptStatus); err != nil || receiptStatus != "delivered" {
		t.Fatalf("recipient receipt status=%q err=%v", receiptStatus, err)
	}
	select {
	case userID := <-push.users:
		if userID != 2 {
			t.Fatalf("push recipient=%d", userID)
		}
	case <-time.After(time.Second):
		t.Fatal("push notification was not sent")
	}
}

func TestDeleteMessageClearsReplies(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	author := registerMessageUserNamed(t, authHandler, "reply_author", "Reply Author")
	registerMessageUserNamed(t, authHandler, "reply_recipient", "Reply Recipient")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	conversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('private',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := conversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'owner-key','owner',?),(?,2,'member-key','member',?)`, conversationID, now, conversationID, now); err != nil {
		t.Fatal(err)
	}
	parentResult, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,1,'parent','parent-iv',?)`, conversationID, now)
	if err != nil {
		t.Fatal(err)
	}
	parentID, _ := parentResult.LastInsertId()
	replyResult, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,reply_to,created_at)
		VALUES(?,1,'reply','reply-iv',?,?)`, conversationID, parentID, now)
	if err != nil {
		t.Fatal(err)
	}
	replyID, _ := replyResult.LastInsertId()

	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := http.NewServeMux()
	mux.Handle("DELETE /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(handler.Delete)))
	request := httptest.NewRequest(http.MethodDelete, "/api/messages/"+formatMessageID(parentID), nil)
	request.AddCookie(author)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("delete parent status=%d body=%s", response.Code, response.Body.String())
	}
	var parentCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM messages WHERE id=?`, parentID).Scan(&parentCount); err != nil || parentCount != 0 {
		t.Fatalf("parent count=%d err=%v", parentCount, err)
	}
	var replyTo sql.NullInt64
	if err := db.QueryRow(`SELECT reply_to FROM messages WHERE id=?`, replyID).Scan(&replyTo); err != nil || replyTo.Valid {
		t.Fatalf("reply_to=%v err=%v", replyTo, err)
	}
}

func TestAuthorCanDeleteMessage(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	cookie := registerMessageUser(t, authHandler)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	conversation, err := db.Exec(`INSERT INTO conversations(type,encrypted_title,created_by,created_at) VALUES('private',NULL,1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := conversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'ecdh-v1','owner',?)`, conversationID, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
		VALUES(2,'message_recipient','Message Recipient','hash','public-key','private-key','salt',?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,2,'ecdh-v1','member',?)`, conversationID, now); err != nil {
		t.Fatal(err)
	}
	message, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,1,'encrypted','message-iv',?)`, conversationID, now)
	if err != nil {
		t.Fatal(err)
	}
	messageID, _ := message.LastInsertId()

	hub := &testHub{}
	handler := &Handler{DB: db, Hub: hub}
	mux := http.NewServeMux()
	mux.Handle("PUT /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(handler.Update)))
	mux.Handle("POST /api/messages/{id}/reactions", authHandler.Middleware(http.HandlerFunc(handler.React)))
	mux.Handle("POST /api/messages/{id}/pin", authHandler.Middleware(http.HandlerFunc(handler.Pin)))
	mux.Handle("DELETE /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(handler.Delete)))
	updateBody := bytes.NewBufferString(`{"encrypted_content":"updated-encrypted","iv":"updated-message-iv"}`)
	updateRequest := httptest.NewRequest(http.MethodPut, "/api/messages/"+formatMessageID(messageID), updateBody)
	updateRequest.Header.Set("Content-Type", "application/json")
	updateRequest.AddCookie(cookie)
	updateResponse := httptest.NewRecorder()
	mux.ServeHTTP(updateResponse, updateRequest)
	if updateResponse.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", updateResponse.Code, updateResponse.Body.String())
	}
	var content string
	var updatedAt *string
	if err := db.QueryRow(`SELECT encrypted_content,updated_at FROM messages WHERE id=?`, messageID).Scan(&content, &updatedAt); err != nil ||
		content != "updated-encrypted" || updatedAt == nil {
		t.Fatalf("updated content=%q updated_at=%v err=%v", content, updatedAt, err)
	}
	reactRequest := httptest.NewRequest(http.MethodPost, "/api/messages/"+formatMessageID(messageID)+"/reactions", bytes.NewBufferString(`{"emoji":"👍"}`))
	reactRequest.Header.Set("Content-Type", "application/json")
	reactRequest.AddCookie(cookie)
	reactResponse := httptest.NewRecorder()
	mux.ServeHTTP(reactResponse, reactRequest)
	if reactResponse.Code != http.StatusOK {
		t.Fatalf("react status=%d body=%s", reactResponse.Code, reactResponse.Body.String())
	}
	var reactions int
	if err := db.QueryRow(`SELECT COUNT(*) FROM message_reactions WHERE message_id=? AND user_id=1 AND emoji='👍'`, messageID).Scan(&reactions); err != nil || reactions != 1 {
		t.Fatalf("reaction count=%d err=%v", reactions, err)
	}
	pinRequest := httptest.NewRequest(http.MethodPost, "/api/messages/"+formatMessageID(messageID)+"/pin", bytes.NewBufferString(`{"pinned":true}`))
	pinRequest.Header.Set("Content-Type", "application/json")
	pinRequest.AddCookie(cookie)
	pinResponse := httptest.NewRecorder()
	mux.ServeHTTP(pinResponse, pinRequest)
	if pinResponse.Code != http.StatusOK {
		t.Fatalf("pin status=%d body=%s", pinResponse.Code, pinResponse.Body.String())
	}
	var pinnedBy sql.NullInt64
	if err := db.QueryRow(`SELECT pinned_by FROM messages WHERE id=?`, messageID).Scan(&pinnedBy); err != nil || !pinnedBy.Valid || pinnedBy.Int64 != 1 {
		t.Fatalf("pinned_by=%v err=%v", pinnedBy, err)
	}
	request := httptest.NewRequest(http.MethodDelete, "/api/messages/"+formatMessageID(messageID), nil)
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", response.Code, response.Body.String())
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM messages WHERE id=?`, messageID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("message count=%d err=%v", count, err)
	}
	if len(hub.sent) != 8 {
		t.Fatalf("broadcast count=%d, want 8 (update, reaction, pin, delete events)", len(hub.sent))
	}
	deleteRecipients := map[int64]bool{}
	for _, sent := range hub.sent {
		event, ok := sent.event.(map[string]any)
		if !ok || event["type"] != "message_deleted" {
			continue
		}
		if event["message_id"] != messageID || event["conversation_id"] != conversationID {
			t.Fatalf("unexpected delete event: %#v", event)
		}
		deleteRecipients[sent.userID] = true
	}
	if !deleteRecipients[1] || !deleteRecipients[2] || len(deleteRecipients) != 2 {
		t.Fatalf("delete recipients=%v, want users 1 and 2", deleteRecipients)
	}
}

func TestListOnlyReturnsMessagesAfterMembershipCreatedAt(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	registerMessageUserNamed(t, authHandler, "history_owner", "History Owner")
	member := registerMessageUserNamed(t, authHandler, "history_member", "History Member")
	conversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('group',1,'2026-01-01T00:00:00Z')`)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := conversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'owner-key','owner','2026-01-01T00:00:00Z'),(?,2,'member-key','member','2026-01-02T00:00:00Z')`,
		conversationID, conversationID); err != nil {
		t.Fatal(err)
	}
	for _, message := range []struct {
		content   string
		createdAt string
	}{
		{content: "old-encrypted-message", createdAt: "2026-01-01T12:00:00Z"},
		{content: "new-encrypted-message", createdAt: "2026-01-02T12:00:00Z"},
	} {
		if _, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
			VALUES(?,1,?,'message-iv',?)`, conversationID, message.content, message.createdAt); err != nil {
			t.Fatal(err)
		}
	}
	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := http.NewServeMux()
	mux.Handle("GET /api/conversations/{id}/messages", authHandler.Middleware(http.HandlerFunc(handler.List)))
	request := httptest.NewRequest(http.MethodGet, "/api/conversations/"+formatMessageID(conversationID)+"/messages", nil)
	request.AddCookie(member)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", response.Code, response.Body.String())
	}
	var messages []Message
	if err := json.Unmarshal(response.Body.Bytes(), &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 1 || messages[0].EncryptedContent == nil || *messages[0].EncryptedContent != "new-encrypted-message" {
		t.Fatalf("visible messages=%+v", messages)
	}
}

func registerMessageUser(t *testing.T, handler *auth.Handler) *http.Cookie {
	return registerMessageUserNamed(t, handler, "message_author", "Message Author")
}

func TestRemovedConversationMemberCannotMutateOldMessages(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	author := registerMessageUserNamed(t, authHandler, "removed_author", "Removed Author")
	removedReader := registerMessageUserNamed(t, authHandler, "removed_reader", "Removed Reader")
	now := time.Now().UTC().Format(time.RFC3339Nano)

	updateConversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('group',2,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	updateConversationID, _ := updateConversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,2,'member-key','member',?)`, updateConversationID, now); err != nil {
		t.Fatal(err)
	}
	updateMessage, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,1,'encrypted','message-iv',?)`, updateConversationID, now)
	if err != nil {
		t.Fatal(err)
	}
	updateMessageID, _ := updateMessage.LastInsertId()

	readConversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('group',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	readConversationID, _ := readConversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'owner-key','owner',?)`, readConversationID, now); err != nil {
		t.Fatal(err)
	}
	readMessage, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,1,'encrypted','message-iv',?)`, readConversationID, now)
	if err != nil {
		t.Fatal(err)
	}
	readMessageID, _ := readMessage.LastInsertId()
	if _, err := db.Exec(`INSERT INTO message_receipts(message_id,user_id,status,created_at)
		VALUES(?,2,'sent',?)`, readMessageID, now); err != nil {
		t.Fatal(err)
	}

	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := http.NewServeMux()
	mux.Handle("POST /api/messages/{id}/read", authHandler.Middleware(http.HandlerFunc(handler.Read)))
	mux.Handle("PUT /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(handler.Update)))
	mux.Handle("DELETE /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(handler.Delete)))

	updateRequest := httptest.NewRequest(http.MethodPut, "/api/messages/"+formatMessageID(updateMessageID), bytes.NewBufferString(`{"encrypted_content":"updated-encrypted","iv":"updated-message-iv"}`))
	updateRequest.Header.Set("Content-Type", "application/json")
	updateRequest.AddCookie(author)
	updateResponse := httptest.NewRecorder()
	mux.ServeHTTP(updateResponse, updateRequest)
	if updateResponse.Code != http.StatusNotFound {
		t.Fatalf("removed author update status=%d body=%s", updateResponse.Code, updateResponse.Body.String())
	}

	deleteRequest := httptest.NewRequest(http.MethodDelete, "/api/messages/"+formatMessageID(updateMessageID), nil)
	deleteRequest.AddCookie(author)
	deleteResponse := httptest.NewRecorder()
	mux.ServeHTTP(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusNotFound {
		t.Fatalf("removed author delete status=%d body=%s", deleteResponse.Code, deleteResponse.Body.String())
	}

	readRequest := httptest.NewRequest(http.MethodPost, "/api/messages/"+formatMessageID(readMessageID)+"/read", nil)
	readRequest.AddCookie(removedReader)
	readResponse := httptest.NewRecorder()
	mux.ServeHTTP(readResponse, readRequest)
	if readResponse.Code != http.StatusNotFound {
		t.Fatalf("removed reader read status=%d body=%s", readResponse.Code, readResponse.Body.String())
	}
	var receiptStatus string
	if err := db.QueryRow(`SELECT status FROM message_receipts WHERE message_id=? AND user_id=2`, readMessageID).Scan(&receiptStatus); err != nil || receiptStatus != "sent" {
		t.Fatalf("removed reader receipt status=%q err=%v", receiptStatus, err)
	}
}

func registerMessageUserNamed(t *testing.T, handler *auth.Handler, username, displayName string) *http.Cookie {
	t.Helper()
	payload := map[string]string{
		"username": username, "display_name": displayName, "password": "Password123!",
		"public_key":            `{"kty":"EC","x":"public-key-placeholder"}`,
		"encrypted_private_key": `{"iv":"private-iv","data":"encrypted-private-key"}`,
		"crypto_salt":           "crypto-salt-value",
	}
	data, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.Register(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("register status=%d body=%s", response.Code, response.Body.String())
	}
	return response.Result().Cookies()[0]
}

func formatMessageID(id int64) string {
	return strconv.FormatInt(id, 10)
}

func hasMessageEvent(events []sentEvent, userID int64, eventType string) bool {
	for _, sent := range events {
		if sent.userID != userID {
			continue
		}
		event, ok := sent.event.(map[string]any)
		if ok && event["type"] == eventType {
			return true
		}
	}
	return false
}
