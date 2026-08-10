package conversations

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

// The conversation list used to compute its last message, unread count and
// member count with correlated subqueries evaluated once per row. These tests
// pin the semantics the rewritten single query must preserve.

// A member must not see anything sent before they joined, neither as the last
// message nor in the unread count.
func TestListIgnoresMessagesSentBeforeTheMemberJoined(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	owner := registerUser(t, authHandler, "history_owner")
	latecomer := registerUser(t, authHandler, "history_latecomer")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)
	conversationID := createPrivateConversation(t, mux, owner, 2)

	// The second member joins after the first message was written.
	if _, err := db.Exec(`UPDATE conversation_members SET created_at='2026-06-01T00:00:00Z' WHERE conversation_id=? AND user_id=2`, conversationID); err != nil {
		t.Fatal(err)
	}
	insertListMessage(t, db, 1, conversationID, 1, "before-joining", "2026-05-01T00:00:00Z")
	insertReceipt(t, db, 1, 2, "sent", "2026-05-01T00:00:00Z")
	insertListMessage(t, db, 2, conversationID, 1, "after-joining", "2026-07-01T00:00:00Z")
	insertReceipt(t, db, 2, 2, "sent", "2026-07-01T00:00:00Z")

	conversations := listConversations(t, mux, latecomer)
	if len(conversations) != 1 {
		t.Fatalf("conversations=%d", len(conversations))
	}
	item := conversations[0]
	if item.UnreadCount != 1 {
		t.Fatalf("unread_count=%d, want 1: the message predating the membership must not count", item.UnreadCount)
	}
	if item.LastMessageEncrypted == nil || *item.LastMessageEncrypted != "after-joining" {
		t.Fatalf("last message=%v, want the first message visible to this member", item.LastMessageEncrypted)
	}
	if item.LastMessageAt == nil || *item.LastMessageAt != "2026-07-01T00:00:00Z" {
		t.Fatalf("last_message_at=%v", item.LastMessageAt)
	}
}

// An expired message is invisible: it must not become the preview line, and it
// must not inflate the unread badge.
func TestListIgnoresExpiredMessages(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	owner := registerUser(t, authHandler, "expiry_owner")
	reader := registerUser(t, authHandler, "expiry_reader")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)
	conversationID := createPrivateConversation(t, mux, owner, 2)

	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	old := time.Now().UTC().Add(-2 * time.Hour).Format(time.RFC3339Nano)
	joined := time.Now().UTC().Add(-3 * time.Hour).Format(time.RFC3339Nano)
	if _, err := db.Exec(`UPDATE conversation_members SET created_at=? WHERE conversation_id=?`, joined, conversationID); err != nil {
		t.Fatal(err)
	}
	insertListMessage(t, db, 1, conversationID, 1, "still-visible", old)
	insertReceipt(t, db, 1, 2, "sent", old)
	insertListMessage(t, db, 2, conversationID, 1, "already-expired", past)
	insertReceipt(t, db, 2, 2, "sent", past)
	if _, err := db.Exec(`UPDATE messages SET expires_at=? WHERE id=2`, past); err != nil {
		t.Fatal(err)
	}

	conversations := listConversations(t, mux, reader)
	item := conversations[0]
	if item.UnreadCount != 1 {
		t.Fatalf("unread_count=%d, want 1: the expired message must not count", item.UnreadCount)
	}
	if item.LastMessageEncrypted == nil || *item.LastMessageEncrypted != "still-visible" {
		t.Fatalf("last message=%v, want the newest non-expired message", item.LastMessageEncrypted)
	}
}

// is_personal is derived from the member count, which the rewrite now computes
// in a shared aggregate instead of a per-row subquery.
func TestListMarksOnlyTheSoloConversationAsPersonal(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	owner := registerUser(t, authHandler, "personal_owner")
	registerUser(t, authHandler, "personal_peer")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)

	shared := createPrivateConversation(t, mux, owner, 2)
	personal := request(t, mux, http.MethodPost, "/api/conversations/personal", nil, owner)
	if personal.Code != http.StatusCreated {
		t.Fatalf("personal conversation status=%d body=%s", personal.Code, personal.Body.String())
	}

	conversations := listConversations(t, mux, owner)
	if len(conversations) != 2 {
		t.Fatalf("conversations=%d", len(conversations))
	}
	personalSeen, sharedSeen := 0, 0
	for _, item := range conversations {
		if item.IsPersonal {
			personalSeen++
			continue
		}
		if formatID(item.ID) == shared {
			sharedSeen++
		}
	}
	if personalSeen != 1 || sharedSeen != 1 {
		t.Fatalf("personal=%d shared=%d in %#v", personalSeen, sharedSeen, conversations)
	}
}

// A conversation with no message at all must still be listed, with an empty
// preview: the rewrite turned the subqueries into outer joins, and a missing
// aggregate row must not drop the conversation.
func TestListKeepsConversationsWithoutMessages(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db, Hub: testHub{}}
	owner := registerUser(t, authHandler, "empty_owner")
	registerUser(t, authHandler, "empty_peer")
	mux := conversationMux(authHandler, handler)
	ensureAcceptedContact(t, db, 1, 2)
	createPrivateConversation(t, mux, owner, 2)

	conversations := listConversations(t, mux, owner)
	if len(conversations) != 1 {
		t.Fatalf("conversations=%d, want the empty conversation to be listed", len(conversations))
	}
	item := conversations[0]
	if item.LastMessageAt != nil || item.LastMessageEncrypted != nil {
		t.Fatalf("empty conversation carries a preview: %#v", item)
	}
	if item.UnreadCount != 0 {
		t.Fatalf("unread_count=%d, want 0", item.UnreadCount)
	}
	if item.LastMessageKeyEpoch != 1 {
		t.Fatalf("last_message_key_epoch=%d, want the default 1", item.LastMessageKeyEpoch)
	}
}

func listConversations(t *testing.T, mux http.Handler, session *http.Cookie) []Conversation {
	t.Helper()
	response := request(t, mux, http.MethodGet, "/api/conversations", nil, session)
	if response.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", response.Code, response.Body.String())
	}
	var conversations []Conversation
	if err := json.Unmarshal(response.Body.Bytes(), &conversations); err != nil {
		t.Fatal(err)
	}
	return conversations
}

func insertListMessage(t *testing.T, db *sql.DB, id int64, conversationID string, senderID int64, content, createdAt string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO messages(id,conversation_id,sender_id,encrypted_content,iv,key_epoch,created_at,message_kind,revision)
		VALUES(?,?,?,?,?,1,?,'text',1)`, id, conversationID, senderID, content, "message-iv", createdAt); err != nil {
		t.Fatal(err)
	}
}

func insertReceipt(t *testing.T, db *sql.DB, messageID, userID int64, status, createdAt string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO message_receipts(message_id,user_id,status,created_at) VALUES(?,?,?,?)`,
		messageID, userID, status, createdAt); err != nil {
		t.Fatal(err)
	}
}
