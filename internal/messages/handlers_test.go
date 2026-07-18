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

type testFederationRouter struct {
	created      []Message
	updated      []int64
	deleted      []int64
	voted        []int64
	eventUpdated []int64
	eventDeleted []int64
}

func (r *testFederationRouter) QueueMessage(message Message) {
	r.created = append(r.created, message)
}

func (r *testFederationRouter) QueueMessageUpdate(messageID int64, _, _, _ string) {
	r.updated = append(r.updated, messageID)
}
func (r *testFederationRouter) QueueMessageDelete(_ int64, messageID int64, _ int64) {
	r.deleted = append(r.deleted, messageID)
}
func (r *testFederationRouter) QueueReaction(_ int64, _ int64, _ string, _ bool, _ string) {}
func (r *testFederationRouter) QueuePin(_ int64, _ int64, _ bool, _ string)                {}
func (r *testFederationRouter) QueueReceipt(_ int64, _ int64, _, _ string)                 {}
func (r *testFederationRouter) QueueFile(_ int64)                                          {}
func (r *testFederationRouter) RelayRealtime(_ int64, _ int64, _ map[string]any) bool {
	return false
}
func (r *testFederationRouter) RelayPresence(_ int64, _ bool)           {}
func (r *testFederationRouter) QueueGroupCreate(_ int64)                {}
func (r *testFederationRouter) QueueGroupAccept(_ int64, _ int64)       {}
func (r *testFederationRouter) QueueGroupUpdate(_ int64)                {}
func (r *testFederationRouter) QueueGroupDelete(_ int64, _ int64)       {}
func (r *testFederationRouter) QueueGroupMemberAdd(_ int64, _ int64)    {}
func (r *testFederationRouter) QueueGroupMemberRemove(_ int64, _ int64) {}

func (r *testFederationRouter) QueuePollUpdate(messageID int64, _, _ string, _ int, _ *string) {
	r.updated = append(r.updated, messageID)
}

func (r *testFederationRouter) QueuePollDelete(_ int64, messageID int64, _ int64) {
	r.deleted = append(r.deleted, messageID)
}

func (r *testFederationRouter) QueuePollVote(messageID int64, _ int64, _ int, _ string) {
	r.voted = append(r.voted, messageID)
}

func (r *testFederationRouter) QueueEventUpdate(messageID int64, _, _, _, _ string) {
	r.eventUpdated = append(r.eventUpdated, messageID)
}

func (r *testFederationRouter) QueueEventDelete(_ int64, messageID int64, _ int64) {
	r.eventDeleted = append(r.eventDeleted, messageID)
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
	var pinCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM message_pins WHERE message_id=? AND user_id=1`, messageID).Scan(&pinCount); err != nil || pinCount != 1 {
		t.Fatalf("personal pin count=%d err=%v", pinCount, err)
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
	if len(hub.sent) != 7 {
		t.Fatalf("broadcast count=%d, want 7 (update, reaction, personal pin, delete events)", len(hub.sent))
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

func TestMessagePinsArePersonalToEachMember(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	first := registerMessageUserNamed(t, authHandler, "first_pinner", "First Pinner")
	second := registerMessageUserNamed(t, authHandler, "second_pinner", "Second Pinner")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	conversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('private',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := conversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'first-key','owner',?),(?,2,'second-key','member',?)`, conversationID, now, conversationID, now); err != nil {
		t.Fatal(err)
	}
	message, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,1,'encrypted','message-iv',?)`, conversationID, now)
	if err != nil {
		t.Fatal(err)
	}
	messageID, _ := message.LastInsertId()

	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := http.NewServeMux()
	mux.Handle("GET /api/conversations/{id}/messages", authHandler.Middleware(http.HandlerFunc(handler.List)))
	mux.Handle("GET /api/conversations/{id}/pinned-messages", authHandler.Middleware(http.HandlerFunc(handler.ListPinned)))
	mux.Handle("POST /api/messages/{id}/pin", authHandler.Middleware(http.HandlerFunc(handler.Pin)))

	setPin := func(cookie *http.Cookie, pinned bool) {
		t.Helper()
		request := httptest.NewRequest(http.MethodPost, "/api/messages/"+formatMessageID(messageID)+"/pin", bytes.NewBufferString(`{"pinned":`+strconv.FormatBool(pinned)+`}`))
		request.Header.Set("Content-Type", "application/json")
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("set pin=%t status=%d body=%s", pinned, response.Code, response.Body.String())
		}
	}
	list := func(cookie *http.Cookie, path string) []Message {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.AddCookie(cookie)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("list %s status=%d body=%s", path, response.Code, response.Body.String())
		}
		var result []Message
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}

	setPin(first, true)
	conversationPath := "/api/conversations/" + formatMessageID(conversationID)
	firstMessages := list(first, conversationPath+"/messages")
	secondMessages := list(second, conversationPath+"/messages")
	if len(firstMessages) != 1 || !firstMessages[0].IsPinned {
		t.Fatalf("first member messages=%+v, want personal pin", firstMessages)
	}
	if len(secondMessages) != 1 || secondMessages[0].IsPinned {
		t.Fatalf("second member messages=%+v, pin must remain private", secondMessages)
	}
	if pins := list(first, conversationPath+"/pinned-messages"); len(pins) != 1 || pins[0].ID != messageID {
		t.Fatalf("first member pins=%+v", pins)
	}
	if pins := list(second, conversationPath+"/pinned-messages"); len(pins) != 0 {
		t.Fatalf("second member pins=%+v, want none", pins)
	}

	setPin(second, true)
	setPin(first, false)
	var firstCount, secondCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM message_pins WHERE message_id=? AND user_id=1`, messageID).Scan(&firstCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM message_pins WHERE message_id=? AND user_id=2`, messageID).Scan(&secondCount); err != nil {
		t.Fatal(err)
	}
	if firstCount != 0 || secondCount != 1 {
		t.Fatalf("personal pin counts first=%d second=%d", firstCount, secondCount)
	}
}

func TestPollLifecycleEnforcesOwnerAndSingleVote(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	owner := registerMessageUserNamed(t, authHandler, "poll_owner", "Poll Owner")
	member := registerMessageUserNamed(t, authHandler, "poll_member", "Poll Member")
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

	federation := &testFederationRouter{}
	handler := &Handler{DB: db, Hub: &testHub{}, Federation: federation}
	mux := http.NewServeMux()
	mux.Handle("POST /api/conversations/{id}/polls", authHandler.Middleware(http.HandlerFunc(handler.CreatePoll)))
	mux.Handle("POST /api/messages/{id}/poll/vote", authHandler.Middleware(http.HandlerFunc(handler.VotePoll)))
	mux.Handle("PUT /api/messages/{id}/poll", authHandler.Middleware(http.HandlerFunc(handler.UpdatePoll)))
	mux.Handle("GET /api/conversations/{id}/messages", authHandler.Middleware(http.HandlerFunc(handler.List)))
	mux.Handle("DELETE /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(handler.Delete)))

	create := httptest.NewRequest(http.MethodPost, "/api/conversations/"+formatMessageID(conversationID)+"/polls",
		bytes.NewBufferString(`{"encrypted_content":"encrypted-poll","iv":"poll-message-iv","option_count":2,"expires_in_seconds":300}`))
	create.Header.Set("Content-Type", "application/json")
	create.AddCookie(owner)
	createResponse := httptest.NewRecorder()
	mux.ServeHTTP(createResponse, create)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create poll status=%d body=%s", createResponse.Code, createResponse.Body.String())
	}
	var created Message
	if err := json.Unmarshal(createResponse.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Poll == nil || len(created.Poll.Options) != 2 || created.Poll.ExpiresAt == nil || created.Poll.Closed {
		t.Fatalf("created poll=%+v", created.Poll)
	}
	if len(federation.created) != 1 || federation.created[0].ID != created.ID {
		t.Fatalf("federated creations=%+v", federation.created)
	}

	votePath := "/api/messages/" + formatMessageID(created.ID) + "/poll/vote"
	vote := httptest.NewRequest(http.MethodPost, votePath,
		bytes.NewBufferString(`{"option_id":`+formatMessageID(created.Poll.Options[0].ID)+`}`))
	vote.Header.Set("Content-Type", "application/json")
	vote.AddCookie(member)
	voteResponse := httptest.NewRecorder()
	mux.ServeHTTP(voteResponse, vote)
	if voteResponse.Code != http.StatusOK {
		t.Fatalf("vote status=%d body=%s", voteResponse.Code, voteResponse.Body.String())
	}
	if len(federation.voted) != 1 || federation.voted[0] != created.ID {
		t.Fatalf("federated votes=%v", federation.voted)
	}

	secondVote := httptest.NewRequest(http.MethodPost, votePath,
		bytes.NewBufferString(`{"option_id":`+formatMessageID(created.Poll.Options[1].ID)+`}`))
	secondVote.Header.Set("Content-Type", "application/json")
	secondVote.AddCookie(member)
	secondVoteResponse := httptest.NewRecorder()
	mux.ServeHTTP(secondVoteResponse, secondVote)
	if secondVoteResponse.Code != http.StatusConflict {
		t.Fatalf("second vote status=%d body=%s", secondVoteResponse.Code, secondVoteResponse.Body.String())
	}

	list := httptest.NewRequest(http.MethodGet, "/api/conversations/"+formatMessageID(conversationID)+"/messages", nil)
	list.AddCookie(member)
	listResponse := httptest.NewRecorder()
	mux.ServeHTTP(listResponse, list)
	var listed []Message
	if err := json.Unmarshal(listResponse.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Poll == nil || listed[0].Poll.TotalVotes != 1 || !listed[0].Poll.HasVoted || !listed[0].Poll.Options[0].Mine {
		t.Fatalf("listed poll=%+v", listed)
	}

	updateBody := `{"encrypted_content":"updated-encrypted-poll","iv":"updated-poll-message-iv","option_count":3,"expires_in_seconds":3600}`
	memberUpdate := httptest.NewRequest(http.MethodPut, "/api/messages/"+formatMessageID(created.ID)+"/poll", bytes.NewBufferString(updateBody))
	memberUpdate.Header.Set("Content-Type", "application/json")
	memberUpdate.AddCookie(member)
	memberUpdateResponse := httptest.NewRecorder()
	mux.ServeHTTP(memberUpdateResponse, memberUpdate)
	if memberUpdateResponse.Code != http.StatusNotFound {
		t.Fatalf("member update status=%d body=%s", memberUpdateResponse.Code, memberUpdateResponse.Body.String())
	}

	ownerUpdate := httptest.NewRequest(http.MethodPut, "/api/messages/"+formatMessageID(created.ID)+"/poll", bytes.NewBufferString(updateBody))
	ownerUpdate.Header.Set("Content-Type", "application/json")
	ownerUpdate.AddCookie(owner)
	ownerUpdateResponse := httptest.NewRecorder()
	mux.ServeHTTP(ownerUpdateResponse, ownerUpdate)
	if ownerUpdateResponse.Code != http.StatusOK {
		t.Fatalf("owner update status=%d body=%s", ownerUpdateResponse.Code, ownerUpdateResponse.Body.String())
	}
	if len(federation.updated) != 1 || federation.updated[0] != created.ID {
		t.Fatalf("federated updates=%v", federation.updated)
	}
	var options, votes int
	if err := db.QueryRow(`SELECT COUNT(*) FROM poll_options WHERE message_id=?`, created.ID).Scan(&options); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM poll_votes WHERE message_id=?`, created.ID).Scan(&votes); err != nil {
		t.Fatal(err)
	}
	if options != 3 || votes != 0 {
		t.Fatalf("after update options=%d votes=%d", options, votes)
	}
	var updatedExpiry string
	if err := db.QueryRow(`SELECT poll_expires_at FROM messages WHERE id=?`, created.ID).Scan(&updatedExpiry); err != nil {
		t.Fatal(err)
	}
	if deadline, err := time.Parse(time.RFC3339Nano, updatedExpiry); err != nil || time.Until(deadline) < 59*time.Minute {
		t.Fatalf("updated expiry=%q err=%v", updatedExpiry, err)
	}
	var updatedOptionID int64
	if err := db.QueryRow(`SELECT id FROM poll_options WHERE message_id=? ORDER BY position LIMIT 1`, created.ID).Scan(&updatedOptionID); err != nil {
		t.Fatal(err)
	}
	expiredAt := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	if _, err := db.Exec(`UPDATE messages SET poll_expires_at=? WHERE id=?`, expiredAt, created.ID); err != nil {
		t.Fatal(err)
	}
	expiredVote := httptest.NewRequest(http.MethodPost, votePath,
		bytes.NewBufferString(`{"option_id":`+formatMessageID(updatedOptionID)+`}`))
	expiredVote.Header.Set("Content-Type", "application/json")
	expiredVote.AddCookie(member)
	expiredVoteResponse := httptest.NewRecorder()
	mux.ServeHTTP(expiredVoteResponse, expiredVote)
	if expiredVoteResponse.Code != http.StatusGone {
		t.Fatalf("expired vote status=%d body=%s", expiredVoteResponse.Code, expiredVoteResponse.Body.String())
	}
	if len(federation.voted) != 1 {
		t.Fatalf("expired vote was federated: %v", federation.voted)
	}
	expiredList := httptest.NewRequest(http.MethodGet, "/api/conversations/"+formatMessageID(conversationID)+"/messages", nil)
	expiredList.AddCookie(member)
	expiredListResponse := httptest.NewRecorder()
	mux.ServeHTTP(expiredListResponse, expiredList)
	listed = nil
	if err := json.Unmarshal(expiredListResponse.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Poll == nil || !listed[0].Poll.Closed || listed[0].Poll.ExpiresAt == nil {
		t.Fatalf("expired listed poll=%+v", listed)
	}

	memberDelete := httptest.NewRequest(http.MethodDelete, "/api/messages/"+formatMessageID(created.ID), nil)
	memberDelete.AddCookie(member)
	memberDeleteResponse := httptest.NewRecorder()
	mux.ServeHTTP(memberDeleteResponse, memberDelete)
	if memberDeleteResponse.Code != http.StatusNotFound {
		t.Fatalf("member delete status=%d body=%s", memberDeleteResponse.Code, memberDeleteResponse.Body.String())
	}
	ownerDelete := httptest.NewRequest(http.MethodDelete, "/api/messages/"+formatMessageID(created.ID), nil)
	ownerDelete.AddCookie(owner)
	ownerDeleteResponse := httptest.NewRecorder()
	mux.ServeHTTP(ownerDeleteResponse, ownerDelete)
	if ownerDeleteResponse.Code != http.StatusOK {
		t.Fatalf("owner delete status=%d body=%s", ownerDeleteResponse.Code, ownerDeleteResponse.Body.String())
	}
	if len(federation.deleted) != 1 || federation.deleted[0] != created.ID {
		t.Fatalf("federated deletions=%v", federation.deleted)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM poll_options WHERE message_id=?`, created.ID).Scan(&options); err != nil || options != 0 {
		t.Fatalf("options after delete=%d err=%v", options, err)
	}
}

func TestEventLifecycleCalendarAndOwnerPermissions(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	owner := registerMessageUserNamed(t, authHandler, "event_owner", "Event Owner")
	member := registerMessageUserNamed(t, authHandler, "event_member", "Event Member")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	conversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('group',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := conversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'owner-key','owner',?),(?,2,'member-key','member',?)`, conversationID, now, conversationID, now); err != nil {
		t.Fatal(err)
	}
	federation := &testFederationRouter{}
	handler := &Handler{DB: db, Hub: &testHub{}, Federation: federation}
	mux := http.NewServeMux()
	mux.Handle("POST /api/conversations/{id}/events", authHandler.Middleware(http.HandlerFunc(handler.CreateEvent)))
	mux.Handle("PUT /api/messages/{id}/event", authHandler.Middleware(http.HandlerFunc(handler.UpdateEvent)))
	mux.Handle("GET /api/events", authHandler.Middleware(http.HandlerFunc(handler.ListEvents)))
	mux.Handle("DELETE /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(handler.Delete)))

	start := time.Now().UTC().Add(time.Hour).Truncate(time.Second)
	end := start.Add(90 * time.Minute)
	createBody := `{"encrypted_content":"encrypted-event","iv":"event-message-iv","starts_at":"` + start.Format(time.RFC3339Nano) + `","ends_at":"` + end.Format(time.RFC3339Nano) + `"}`
	create := httptest.NewRequest(http.MethodPost, "/api/conversations/"+formatMessageID(conversationID)+"/events", bytes.NewBufferString(createBody))
	create.Header.Set("Content-Type", "application/json")
	create.AddCookie(owner)
	createResponse := httptest.NewRecorder()
	mux.ServeHTTP(createResponse, create)
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create event status=%d body=%s", createResponse.Code, createResponse.Body.String())
	}
	var created Message
	if err := json.Unmarshal(createResponse.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Event == nil || created.Event.StartsAt != start.Format(time.RFC3339Nano) || created.Event.EndsAt != end.Format(time.RFC3339Nano) {
		t.Fatalf("created event=%+v", created.Event)
	}
	if len(federation.created) != 1 || federation.created[0].Event == nil {
		t.Fatalf("federated create=%+v", federation.created)
	}

	calendar := httptest.NewRequest(http.MethodGet, "/api/events", nil)
	calendar.AddCookie(member)
	calendarResponse := httptest.NewRecorder()
	mux.ServeHTTP(calendarResponse, calendar)
	var listed []Message
	if err := json.Unmarshal(calendarResponse.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].ID != created.ID || listed[0].Event == nil {
		t.Fatalf("calendar events=%+v", listed)
	}

	updatedStart := start.Add(24 * time.Hour)
	updatedEnd := updatedStart.Add(2 * time.Hour)
	updateBody := `{"encrypted_content":"updated-encrypted-event","iv":"updated-event-iv","starts_at":"` + updatedStart.Format(time.RFC3339Nano) + `","ends_at":"` + updatedEnd.Format(time.RFC3339Nano) + `"}`
	memberUpdate := httptest.NewRequest(http.MethodPut, "/api/messages/"+formatMessageID(created.ID)+"/event", bytes.NewBufferString(updateBody))
	memberUpdate.Header.Set("Content-Type", "application/json")
	memberUpdate.AddCookie(member)
	memberUpdateResponse := httptest.NewRecorder()
	mux.ServeHTTP(memberUpdateResponse, memberUpdate)
	if memberUpdateResponse.Code != http.StatusNotFound {
		t.Fatalf("member update status=%d body=%s", memberUpdateResponse.Code, memberUpdateResponse.Body.String())
	}
	ownerUpdate := httptest.NewRequest(http.MethodPut, "/api/messages/"+formatMessageID(created.ID)+"/event", bytes.NewBufferString(updateBody))
	ownerUpdate.Header.Set("Content-Type", "application/json")
	ownerUpdate.AddCookie(owner)
	ownerUpdateResponse := httptest.NewRecorder()
	mux.ServeHTTP(ownerUpdateResponse, ownerUpdate)
	if ownerUpdateResponse.Code != http.StatusOK || len(federation.eventUpdated) != 1 {
		t.Fatalf("owner update status=%d federation=%v body=%s", ownerUpdateResponse.Code, federation.eventUpdated, ownerUpdateResponse.Body.String())
	}
	var storedStart, storedEnd string
	if err := db.QueryRow(`SELECT starts_at,ends_at FROM message_events WHERE message_id=?`, created.ID).Scan(&storedStart, &storedEnd); err != nil ||
		storedStart != updatedStart.Format(time.RFC3339Nano) || storedEnd != updatedEnd.Format(time.RFC3339Nano) {
		t.Fatalf("stored dates=%q..%q err=%v", storedStart, storedEnd, err)
	}

	memberDelete := httptest.NewRequest(http.MethodDelete, "/api/messages/"+formatMessageID(created.ID), nil)
	memberDelete.AddCookie(member)
	memberDeleteResponse := httptest.NewRecorder()
	mux.ServeHTTP(memberDeleteResponse, memberDelete)
	if memberDeleteResponse.Code != http.StatusNotFound {
		t.Fatalf("member delete status=%d body=%s", memberDeleteResponse.Code, memberDeleteResponse.Body.String())
	}
	ownerDelete := httptest.NewRequest(http.MethodDelete, "/api/messages/"+formatMessageID(created.ID), nil)
	ownerDelete.AddCookie(owner)
	ownerDeleteResponse := httptest.NewRecorder()
	mux.ServeHTTP(ownerDeleteResponse, ownerDelete)
	if ownerDeleteResponse.Code != http.StatusOK || len(federation.eventDeleted) != 1 {
		t.Fatalf("owner delete status=%d federation=%v body=%s", ownerDeleteResponse.Code, federation.eventDeleted, ownerDeleteResponse.Body.String())
	}
	var remaining int
	if err := db.QueryRow(`SELECT COUNT(*) FROM message_events WHERE message_id=?`, created.ID).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("remaining event=%d err=%v", remaining, err)
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

func TestListSupportsMessagesAfterTargetInChronologicalOrder(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	member := registerMessageUserNamed(t, authHandler, "after_reader", "After Reader")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	conversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('private',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := conversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'owner-key','owner',?)`, conversationID, now); err != nil {
		t.Fatal(err)
	}
	ids := make([]int64, 0, 5)
	for index := 1; index <= 5; index++ {
		result, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at) VALUES(?,1,?,?,?)`,
			conversationID, "encrypted-"+strconv.Itoa(index), "message-iv", now)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		ids = append(ids, id)
	}
	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := http.NewServeMux()
	mux.Handle("GET /api/conversations/{id}/messages", authHandler.Middleware(http.HandlerFunc(handler.List)))
	request := httptest.NewRequest(http.MethodGet,
		"/api/conversations/"+formatMessageID(conversationID)+"/messages?after="+formatMessageID(ids[1])+"&limit=2", nil)
	request.AddCookie(member)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list after status=%d body=%s", response.Code, response.Body.String())
	}
	var messages []Message
	if err := json.Unmarshal(response.Body.Bytes(), &messages); err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].ID != ids[2] || messages[1].ID != ids[3] {
		t.Fatalf("messages after target=%+v want ids %d,%d", messages, ids[2], ids[3])
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
