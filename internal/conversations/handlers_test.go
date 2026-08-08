package conversations

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

type testHub struct{}

func (testHub) SendToUser(int64, any) bool { return false }

type capturedRemovalEvent struct {
	userID int64
	event  any
}

type removalHub struct {
	sent []capturedRemovalEvent
}

func (h *removalHub) SendToUser(userID int64, event any) bool {
	h.sent = append(h.sent, capturedRemovalEvent{userID: userID, event: event})
	return true
}

type removalPushEvent struct {
	userID int64
	title  string
	body   string
	url    string
	tag    string
}

type removalPush struct {
	sent chan removalPushEvent
}

func (p *removalPush) NotifyUserWithContent(userID int64, title, body, url, tag string) {
	p.sent <- removalPushEvent{userID: userID, title: title, body: body, url: url, tag: tag}
}

func TestDeletePrivateConversationRemovesItForBothMembers(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	first := registerUser(t, authHandler, "first_user")
	second := registerUser(t, authHandler, "second_user")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)

	conversationID := createPrivateConversation(t, mux, first, 2)
	response := request(t, mux, http.MethodDelete, "/api/conversations/"+conversationID, nil, first)
	if response.Code != http.StatusOK {
		t.Fatalf("delete private status=%d body=%s", response.Code, response.Body.String())
	}
	assertConversationCount(t, db, conversationID, 0)
	var contacts int
	if err := db.QueryRow(`SELECT COUNT(*) FROM contacts WHERE (owner_id=1 AND contact_user_id=2) OR (owner_id=2 AND contact_user_id=1)`).Scan(&contacts); err != nil || contacts != 0 {
		t.Fatalf("private deletion should remove accepted contacts, contacts=%d err=%v", contacts, err)
	}

	list := request(t, mux, http.MethodGet, "/api/conversations", nil, second)
	if list.Code != http.StatusOK || list.Body.String() != "[]\n" {
		t.Fatalf("second member list status=%d body=%s", list.Code, list.Body.String())
	}
}

func TestListIncludesUnreadCount(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	first := registerUser(t, authHandler, "unread_sender")
	second := registerUser(t, authHandler, "unread_reader")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)

	conversationID := createPrivateConversation(t, mux, first, 2)
	messageCreatedAt := "2026-12-01T00:00:00Z"
	for _, message := range []struct {
		id     int64
		status string
	}{
		{id: 1, status: "sent"},
		{id: 2, status: "read"},
	} {
		if _, err := db.Exec(`INSERT INTO messages(id,conversation_id,sender_id,encrypted_content,iv,created_at)
			VALUES(?,?,?,?,?,?)`, message.id, conversationID, 1, "encrypted-message", "message-iv", messageCreatedAt); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO message_receipts(message_id,user_id,status,created_at)
			VALUES(?,?,?,?)`, message.id, 2, message.status, messageCreatedAt); err != nil {
			t.Fatal(err)
		}
	}

	list := request(t, mux, http.MethodGet, "/api/conversations", nil, second)
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	var conversations []Conversation
	if err := json.Unmarshal(list.Body.Bytes(), &conversations); err != nil {
		t.Fatal(err)
	}
	if len(conversations) != 1 {
		t.Fatalf("conversations=%d", len(conversations))
	}
	if conversations[0].UnreadCount != 1 {
		t.Fatalf("unread_count=%d", conversations[0].UnreadCount)
	}
	if conversations[0].LastMessageEncrypted == nil || *conversations[0].LastMessageEncrypted != "encrypted-message" {
		t.Fatalf("last_message_encrypted_content=%v", conversations[0].LastMessageEncrypted)
	}
	if conversations[0].LastMessageIV == nil || *conversations[0].LastMessageIV != "message-iv" {
		t.Fatalf("last_message_iv=%v", conversations[0].LastMessageIV)
	}
	if conversations[0].LastMessageHasFile {
		t.Fatal("last_message_has_file=true")
	}
}

func TestNewConversationSortsAboveAnOlderConversationWithMessages(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	owner := registerUser(t, authHandler, "recent_conversation_owner")
	registerUser(t, authHandler, "older_conversation_member")
	registerUser(t, authHandler, "new_conversation_member")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)
	ensureAcceptedContact(t, db, 1, 3)

	olderID := createPrivateConversation(t, mux, owner, 2)
	if _, err := db.Exec(`UPDATE conversations SET created_at='2026-01-01T00:00:00Z' WHERE id=?`, olderID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE conversation_members SET created_at='2026-01-01T00:00:00Z' WHERE conversation_id=?`, olderID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,2,'older-message','message-iv','2026-02-01T00:00:00Z')`, olderID); err != nil {
		t.Fatal(err)
	}
	newID := createPrivateConversation(t, mux, owner, 3)

	list := request(t, mux, http.MethodGet, "/api/conversations", nil, owner)
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	var conversations []Conversation
	if err := json.Unmarshal(list.Body.Bytes(), &conversations); err != nil {
		t.Fatal(err)
	}
	if len(conversations) != 2 || formatID(conversations[0].ID) != newID || formatID(conversations[1].ID) != olderID {
		t.Fatalf("new conversation should be first: %#v", conversations)
	}
}

func TestCreatePrivateConversationRequiresAcceptedContact(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	first := registerUser(t, authHandler, "request_owner")
	registerUser(t, authHandler, "request_target")
	mux := conversationMux(authHandler, handler)

	blocked := request(t, mux, http.MethodPost, "/api/conversations/private", map[string]int64{"user_id": 2}, first)
	if blocked.Code != http.StatusForbidden {
		t.Fatalf("create without contact status=%d body=%s", blocked.Code, blocked.Body.String())
	}

	if _, err := db.Exec(`INSERT INTO contacts(owner_id,contact_user_id,status,created_at) VALUES(1,2,'pending','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	pending := request(t, mux, http.MethodPost, "/api/conversations/private", map[string]int64{"user_id": 2}, first)
	if pending.Code != http.StatusForbidden {
		t.Fatalf("create pending contact status=%d body=%s", pending.Code, pending.Body.String())
	}

	if _, err := db.Exec(`UPDATE contacts SET status='accepted' WHERE owner_id=1 AND contact_user_id=2`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO contacts(owner_id,contact_user_id,status,created_at) VALUES(2,1,'accepted','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	accepted := request(t, mux, http.MethodPost, "/api/conversations/private", map[string]int64{"user_id": 2}, first)
	if accepted.Code != http.StatusCreated {
		t.Fatalf("create accepted contact status=%d body=%s", accepted.Code, accepted.Body.String())
	}
}

func TestConversationFavoriteIsPersonalAndSortsFirst(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	owner := registerUser(t, authHandler, "favorite_owner")
	registerUser(t, authHandler, "favorite_member")
	other := registerUser(t, authHandler, "favorite_other")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)
	ensureAcceptedContact(t, db, 1, 3)

	favoriteID := createPrivateConversation(t, mux, owner, 2)
	newerID := createPrivateConversation(t, mux, owner, 3)
	if _, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,3,'newer-message','message-iv','2026-12-01T00:00:00Z')`, newerID); err != nil {
		t.Fatal(err)
	}

	favorited := request(t, mux, http.MethodPatch, "/api/conversations/"+favoriteID+"/favorite",
		map[string]bool{"favorite": true}, owner)
	if favorited.Code != http.StatusOK {
		t.Fatalf("favorite status=%d body=%s", favorited.Code, favorited.Body.String())
	}
	var ownerFavorite, memberFavorite sql.NullString
	if err := db.QueryRow(`SELECT favorite_at FROM conversation_members WHERE conversation_id=? AND user_id=1`, favoriteID).Scan(&ownerFavorite); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT favorite_at FROM conversation_members WHERE conversation_id=? AND user_id=2`, favoriteID).Scan(&memberFavorite); err != nil {
		t.Fatal(err)
	}
	if !ownerFavorite.Valid || memberFavorite.Valid {
		t.Fatalf("favorite should remain personal: owner=%v member=%v", ownerFavorite, memberFavorite)
	}

	list := request(t, mux, http.MethodGet, "/api/conversations", nil, owner)
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	var conversations []Conversation
	if err := json.Unmarshal(list.Body.Bytes(), &conversations); err != nil {
		t.Fatal(err)
	}
	if len(conversations) != 2 || formatID(conversations[0].ID) != favoriteID || conversations[0].FavoriteAt == nil {
		t.Fatalf("favorite should sort first: %#v", conversations)
	}

	blocked := request(t, mux, http.MethodPatch, "/api/conversations/"+favoriteID+"/favorite",
		map[string]bool{"favorite": true}, other)
	if blocked.Code != http.StatusNotFound {
		t.Fatalf("non-member favorite status=%d body=%s", blocked.Code, blocked.Body.String())
	}

	removed := request(t, mux, http.MethodPatch, "/api/conversations/"+favoriteID+"/favorite",
		map[string]bool{"favorite": false}, owner)
	if removed.Code != http.StatusOK {
		t.Fatalf("remove favorite status=%d body=%s", removed.Code, removed.Body.String())
	}
	if err := db.QueryRow(`SELECT favorite_at FROM conversation_members WHERE conversation_id=? AND user_id=1`, favoriteID).Scan(&ownerFavorite); err != nil {
		t.Fatal(err)
	}
	if ownerFavorite.Valid {
		t.Fatalf("favorite_at=%q, want NULL", ownerFavorite.String)
	}

}

func TestCreatePersonalConversationIsIdempotentAndCannotBeDeleted(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	user := registerUser(t, authHandler, "personal_notes_owner")
	mux := conversationMux(authHandler, handler)

	created := request(t, mux, http.MethodPost, "/api/conversations/personal", nil, user)
	if created.Code != http.StatusCreated {
		t.Fatalf("create personal status=%d body=%s", created.Code, created.Body.String())
	}
	var first map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	conversationID := int64(first["id"].(float64))

	existing := request(t, mux, http.MethodPost, "/api/conversations/personal", nil, user)
	if existing.Code != http.StatusOK {
		t.Fatalf("ensure personal status=%d body=%s", existing.Code, existing.Body.String())
	}
	var second map[string]any
	if err := json.Unmarshal(existing.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if int64(second["id"].(float64)) != conversationID || second["existing"] != true {
		t.Fatalf("idempotent response=%v", second)
	}

	list := request(t, mux, http.MethodGet, "/api/conversations", nil, user)
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	var conversations []Conversation
	if err := json.Unmarshal(list.Body.Bytes(), &conversations); err != nil {
		t.Fatal(err)
	}
	if len(conversations) != 1 || !conversations[0].IsPersonal || conversations[0].ID != conversationID {
		t.Fatalf("personal conversations=%+v", conversations)
	}
	var memberCount int
	var encryptedKey string
	if err := db.QueryRow(`SELECT COUNT(*),MIN(encrypted_conversation_key) FROM conversation_members WHERE conversation_id=?`, conversationID).
		Scan(&memberCount, &encryptedKey); err != nil || memberCount != 1 || encryptedKey != "self-ecdh-v1" {
		t.Fatalf("personal member count=%d key=%q err=%v", memberCount, encryptedKey, err)
	}

	deleted := request(t, mux, http.MethodDelete, "/api/conversations/"+formatID(conversationID), nil, user)
	if deleted.Code != http.StatusForbidden {
		t.Fatalf("delete personal status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	assertConversationCount(t, db, formatID(conversationID), 1)
}

func TestGroupMemberLeavesAndOwnerDeletesGroup(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	owner := registerUser(t, authHandler, "group_owner")
	member := registerUser(t, authHandler, "group_member")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)

	body := map[string]any{
		"encrypted_title":       "encrypted-group-title",
		"encrypted_description": "encrypted-group-description",
		"encrypted_avatar":      "encrypted-group-avatar",
		"member_ids":            []int64{2},
		"encrypted_keys": map[string]string{
			"1": "encrypted-owner-key",
			"2": "encrypted-member-key",
		},
	}
	created := request(t, mux, http.MethodPost, "/api/conversations/group", body, owner)
	if created.Code != http.StatusCreated {
		t.Fatalf("create group status=%d body=%s", created.Code, created.Body.String())
	}
	var result map[string]int64
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	id := result["id"]
	path := "/api/conversations/" + formatID(id)
	var role string
	if err := db.QueryRow(`SELECT role FROM conversation_members WHERE conversation_id=? AND user_id=2`, id).Scan(&role); err != nil || role != "pending" {
		t.Fatalf("new group member role=%q err=%v", role, err)
	}
	pendingFavorite := request(t, mux, http.MethodPatch, path+"/favorite", map[string]bool{"favorite": true}, member)
	if pendingFavorite.Code != http.StatusForbidden {
		t.Fatalf("pending favorite status=%d body=%s", pendingFavorite.Code, pendingFavorite.Body.String())
	}
	accepted := request(t, mux, http.MethodPost, path+"/accept", nil, member)
	if accepted.Code != http.StatusOK {
		t.Fatalf("accept group status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	if err := db.QueryRow(`SELECT role FROM conversation_members WHERE conversation_id=? AND user_id=2`, id).Scan(&role); err != nil || role != "member" {
		t.Fatalf("accepted group member role=%q err=%v", role, err)
	}

	updated := request(t, mux, http.MethodPut, path, map[string]string{
		"encrypted_title":       "updated-encrypted-group-title",
		"encrypted_description": "updated-encrypted-group-description",
		"encrypted_avatar":      "updated-encrypted-group-avatar",
	}, owner)
	if updated.Code != http.StatusOK {
		t.Fatalf("update group status=%d body=%s", updated.Code, updated.Body.String())
	}
	var encryptedTitle, encryptedDescription, encryptedAvatar string
	if err := db.QueryRow(`SELECT encrypted_title,encrypted_description,encrypted_avatar FROM conversations WHERE id=?`, id).
		Scan(&encryptedTitle, &encryptedDescription, &encryptedAvatar); err != nil ||
		encryptedTitle != "updated-encrypted-group-title" || encryptedDescription != "updated-encrypted-group-description" ||
		encryptedAvatar != "updated-encrypted-group-avatar" {
		t.Fatalf("encrypted title=%q description=%q avatar=%q err=%v", encryptedTitle, encryptedDescription, encryptedAvatar, err)
	}

	left := request(t, mux, http.MethodDelete, path, nil, member)
	if left.Code != http.StatusOK {
		t.Fatalf("leave group status=%d body=%s", left.Code, left.Body.String())
	}
	var memberCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=?`, id).Scan(&memberCount); err != nil || memberCount != 1 {
		t.Fatalf("member count=%d err=%v", memberCount, err)
	}

	deleted := request(t, mux, http.MethodDelete, path, nil, owner)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete group status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	assertConversationCount(t, db, formatID(id), 0)
}

func TestAddGroupMemberRequiresKeyRotation(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	owner := registerUser(t, authHandler, "invite_owner")
	registerUser(t, authHandler, "invite_target")
	mux := conversationMux(authHandler, handler)
	now := "2026-01-01T00:00:00Z"
	result, err := db.Exec(`INSERT INTO conversations(type,encrypted_title,created_by,created_at) VALUES('group','encrypted-title',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := result.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'owner-key','owner',?)`, conversationID, now); err != nil {
		t.Fatal(err)
	}

	added := request(t, mux, http.MethodPost, "/api/conversations/"+formatID(conversationID)+"/members", map[string]any{
		"user_id":                    2,
		"encrypted_conversation_key": "encrypted-target-key",
	}, owner)
	if added.Code != http.StatusConflict {
		t.Fatalf("add member status=%d body=%s", added.Code, added.Body.String())
	}
	var memberCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=2`, conversationID).Scan(&memberCount); err != nil || memberCount != 0 {
		t.Fatalf("legacy endpoint must not add a member, count=%d err=%v", memberCount, err)
	}
	var contacts int
	if err := db.QueryRow(`SELECT COUNT(*) FROM contacts WHERE owner_id IN (1,2) OR contact_user_id IN (1,2)`).Scan(&contacts); err != nil || contacts != 0 {
		t.Fatalf("contacts should not be created, count=%d err=%v", contacts, err)
	}
}

func TestRemoveGroupMemberNotifiesRemovedUser(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	owner := registerUser(t, authHandler, "removal_owner")
	registerUser(t, authHandler, "removal_member")
	registerUser(t, authHandler, "added_member")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := db.Exec(`INSERT INTO conversations(type,encrypted_title,created_by,created_at) VALUES('group','encrypted-title',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := result.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'owner-key','owner',?),(?,2,'member-key','member',?)`, conversationID, now, conversationID, now); err != nil {
		t.Fatal(err)
	}

	hub := &removalHub{}
	push := &removalPush{sent: make(chan removalPushEvent, 1)}
	handler := &Handler{DB: db, Hub: hub, Push: push}
	mux := conversationMux(authHandler, handler)
	response := request(t, mux, http.MethodPost,
		"/api/conversations/"+formatID(conversationID)+"/rotate-keys", map[string]any{
			"key_epoch":        2,
			"removed_user_ids": []int64{2},
			"added_user_ids":   []int64{3},
			"encrypted_keys": map[string]string{
				"1": "owner-encrypted-key-epoch-2",
				"3": "added-encrypted-key-epoch-2",
			},
			"encrypted_title":       "encrypted-title-epoch-2",
			"encrypted_description": nil,
			"encrypted_avatar":      nil,
		}, owner)
	if response.Code != http.StatusOK {
		t.Fatalf("remove member status=%d body=%s", response.Code, response.Body.String())
	}

	foundRemovalNotice := false
	for _, sent := range hub.sent {
		payload, ok := sent.event.(map[string]any)
		if sent.userID == 2 && ok && payload["removed"] == true && payload["removal_notice"] == true {
			foundRemovalNotice = true
			break
		}
	}
	if !foundRemovalNotice {
		t.Fatalf("removed member did not receive a removal notice: %#v", hub.sent)
	}
	var epoch int64
	var rotationRequired bool
	if err := db.QueryRow(`SELECT current_key_epoch,rotation_required FROM conversations WHERE id=?`, conversationID).Scan(&epoch, &rotationRequired); err != nil || epoch != 2 || rotationRequired {
		t.Fatalf("rotation state epoch=%d required=%v err=%v", epoch, rotationRequired, err)
	}
	var removedMembers, addedMembers, ownerEnvelopes, addedEnvelopes int
	_ = db.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=2`, conversationID).Scan(&removedMembers)
	_ = db.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=3 AND role='pending'`, conversationID).Scan(&addedMembers)
	_ = db.QueryRow(`SELECT COUNT(*) FROM conversation_key_envelopes WHERE conversation_id=? AND key_epoch=2 AND user_id=1`, conversationID).Scan(&ownerEnvelopes)
	_ = db.QueryRow(`SELECT COUNT(*) FROM conversation_key_envelopes WHERE conversation_id=? AND key_epoch=2 AND user_id=3`, conversationID).Scan(&addedEnvelopes)
	if removedMembers != 0 || addedMembers != 1 || ownerEnvelopes != 1 || addedEnvelopes != 1 {
		t.Fatalf("rotation removed=%d added=%d owner envelopes=%d added envelopes=%d", removedMembers, addedMembers, ownerEnvelopes, addedEnvelopes)
	}

	select {
	case notification := <-push.sent:
		if notification.userID != 2 || notification.title != "Retrait d’un groupe" ||
			notification.body != "Vous ne faites plus partie de ce groupe." || notification.url != "/" ||
			notification.tag != "group-removal-"+formatID(conversationID) {
			t.Fatalf("unexpected removal push: %#v", notification)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("removed member did not receive a push notification")
	}
}

func conversationMux(authHandler *auth.Handler, handler *Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("GET /api/conversations", authHandler.Middleware(http.HandlerFunc(handler.List)))
	mux.Handle("POST /api/conversations/private", authHandler.Middleware(http.HandlerFunc(handler.CreatePrivate)))
	mux.Handle("POST /api/conversations/personal", authHandler.Middleware(http.HandlerFunc(handler.CreatePersonal)))
	mux.Handle("POST /api/conversations/group", authHandler.Middleware(http.HandlerFunc(handler.CreateGroup)))
	mux.Handle("POST /api/conversations/{id}/accept", authHandler.Middleware(http.HandlerFunc(handler.Accept)))
	mux.Handle("PATCH /api/conversations/{id}/favorite", authHandler.Middleware(http.HandlerFunc(handler.SetFavorite)))
	mux.Handle("PUT /api/conversations/{id}", authHandler.Middleware(http.HandlerFunc(handler.Update)))
	mux.Handle("DELETE /api/conversations/{id}", authHandler.Middleware(http.HandlerFunc(handler.Delete)))
	mux.Handle("POST /api/conversations/{id}/members", authHandler.Middleware(http.HandlerFunc(handler.AddMember)))
	mux.Handle("POST /api/conversations/{id}/rotate-keys", authHandler.Middleware(http.HandlerFunc(handler.RotateGroupKeys)))
	mux.Handle("DELETE /api/conversations/{id}/members/{user_id}", authHandler.Middleware(http.HandlerFunc(handler.RemoveMember)))
	return mux
}

func createPrivateConversation(t *testing.T, mux http.Handler, cookie *http.Cookie, userID int64) string {
	t.Helper()
	response := request(t, mux, http.MethodPost, "/api/conversations/private", map[string]int64{"user_id": userID}, cookie)
	if response.Code != http.StatusCreated {
		t.Fatalf("create private status=%d body=%s", response.Code, response.Body.String())
	}
	var result map[string]int64
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return formatID(result["id"])
}

func ensureAcceptedContact(t *testing.T, db *sql.DB, ownerID, contactUserID int64) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO contacts(owner_id,contact_user_id,status,created_at) VALUES(?,?,?,?),(?,?,?,?)`,
		ownerID, contactUserID, "accepted", "2026-01-01T00:00:00Z",
		contactUserID, ownerID, "accepted", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
}

func registerUser(t *testing.T, handler *auth.Handler, username string) *http.Cookie {
	t.Helper()
	payload := map[string]string{
		"username": username, "display_name": username, "password": "Password123!",
		"public_key":            `{"kty":"EC","x":"public-key-placeholder"}`,
		"encrypted_private_key": `{"iv":"private-iv","data":"encrypted-private-key"}`,
		"crypto_salt":           "crypto-salt-value",
	}
	data, _ := json.Marshal(payload)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	handler.Register(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("register status=%d body=%s", response.Code, response.Body.String())
	}
	return response.Result().Cookies()[0]
}

func request(t *testing.T, mux http.Handler, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(cookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, req)
	return response
}

func assertConversationCount(t *testing.T, db *sql.DB, id string, want int) {
	t.Helper()
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM conversations WHERE id=?`, id).Scan(&count); err != nil || count != want {
		t.Fatalf("conversation count=%d want=%d err=%v", count, want, err)
	}
}

func formatID(id int64) string {
	return strconv.FormatInt(id, 10)
}
