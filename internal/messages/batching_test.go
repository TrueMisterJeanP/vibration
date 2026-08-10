package messages

import (
	"database/sql"
	"database/sql/driver"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	database "chat-pwa-go/internal/db"
)

// countingConnector wraps the sqlite driver to count the statements a request
// actually sends. It is the only way to assert "a bounded number of queries per
// page" as a regression test rather than as a claim.
type countingConnector struct {
	driver.Connector
	counter *queryCounter
}

type queryCounter struct {
	mu        sync.Mutex
	enabled   bool
	statement []string
}

func (c *queryCounter) reset() {
	c.mu.Lock()
	c.enabled, c.statement = true, nil
	c.mu.Unlock()
}

func (c *queryCounter) record(query string) {
	c.mu.Lock()
	if c.enabled {
		c.statement = append(c.statement, query)
	}
	c.mu.Unlock()
}

func (c *queryCounter) countMatching(fragment string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	total := 0
	for _, query := range c.statement {
		if strings.Contains(query, fragment) {
			total++
		}
	}
	return total
}

// TestMessagePageQueryCountIsIndependentOfPageSize is the regression guard for
// the N+1 removal: loading five messages and loading fifty must cost the same
// number of reaction, poll and event queries.
func TestMessagePageQueryCountIsIndependentOfPageSize(t *testing.T) {
	db, counter := countingTestDB(t)
	handler := &Handler{DB: db}
	seedConversation(t, db, 60)

	for _, size := range []int{5, 50} {
		counter.reset()
		result := loadPage(t, handler, size)
		if len(result) != size {
			t.Fatalf("page of %d returned %d messages", size, len(result))
		}
		reactions := counter.countMatching("FROM message_reactions")
		polls := counter.countMatching("FROM poll_options")
		events := counter.countMatching("FROM message_events")
		if reactions != 1 || polls != 1 || events != 1 {
			t.Fatalf("page of %d issued reactions=%d polls=%d events=%d, want 1 each",
				size, reactions, polls, events)
		}
	}
}

// TestBatchedMetadataMatchesPerMessageResults checks the batched loaders return
// exactly what the per-message versions did: right reaction counts, right
// "mine" flags, right poll totals and the right event on the right message.
func TestBatchedMetadataMatchesPerMessageResults(t *testing.T) {
	db, _ := countingTestDB(t)
	handler := &Handler{DB: db}
	seedConversation(t, db, 3)
	now := time.Now().UTC().Format(time.RFC3339Nano)

	// message 1: two reactions from two users, one of them ours. Distinct
	// timestamps pin the "oldest emoji first" ordering the client relies on.
	earlier := time.Now().UTC().Add(-2 * time.Minute).Format(time.RFC3339Nano)
	later := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano)
	mustExec(t, db, `INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(1,1,'👍',?)`, earlier)
	mustExec(t, db, `INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(1,2,'👍',?)`, later)
	mustExec(t, db, `INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(1,2,'🎉',?)`, later)
	// message 2: a poll with two options, we voted for the second.
	mustExec(t, db, `INSERT INTO poll_options(id,message_id,position) VALUES(10,2,0),(11,2,1)`)
	mustExec(t, db, `INSERT INTO poll_votes(message_id,option_id,user_id,created_at) VALUES(2,11,1,?)`, now)
	mustExec(t, db, `INSERT INTO poll_votes(message_id,option_id,user_id,created_at) VALUES(2,10,2,?)`, now)
	// message 3: a calendar event.
	mustExec(t, db, `INSERT INTO message_events(message_id,starts_at,ends_at) VALUES(3,'2026-09-01T09:00:00Z','2026-09-01T10:00:00Z')`)

	page := loadPage(t, handler, 50)
	byID := map[int64]Message{}
	for _, item := range page {
		byID[item.ID] = item
	}

	first := byID[1]
	if len(first.Reactions) != 2 {
		t.Fatalf("message 1 reactions=%#v", first.Reactions)
	}
	thumbs := first.Reactions[0]
	if thumbs.Emoji != "👍" || thumbs.Count != 2 || !thumbs.Mine {
		t.Fatalf("message 1 first reaction=%#v, want 👍 count 2 mine", thumbs)
	}
	if party := first.Reactions[1]; party.Emoji != "🎉" || party.Count != 1 || party.Mine {
		t.Fatalf("message 1 second reaction=%#v, want 🎉 count 1 not mine", party)
	}
	if first.Poll != nil || first.Event != nil {
		t.Fatal("message 1 must carry neither a poll nor an event")
	}

	second := byID[2]
	if second.Poll == nil || len(second.Poll.Options) != 2 {
		t.Fatalf("message 2 poll=%#v", second.Poll)
	}
	if second.Poll.TotalVotes != 2 || !second.Poll.HasVoted {
		t.Fatalf("message 2 poll totals=%#v", second.Poll)
	}
	if second.Poll.Options[0].Mine || !second.Poll.Options[1].Mine {
		t.Fatalf("message 2 poll ownership=%#v", second.Poll.Options)
	}
	if len(second.Reactions) != 0 {
		t.Fatalf("message 2 must have no reactions, got %#v", second.Reactions)
	}

	third := byID[3]
	if third.Event == nil || third.Event.StartsAt != "2026-09-01T09:00:00Z" || third.Event.EndsAt != "2026-09-01T10:00:00Z" {
		t.Fatalf("message 3 event=%#v", third.Event)
	}
	if third.Poll != nil {
		t.Fatal("message 3 must not carry a poll")
	}
}

func TestBatchedLoadersIgnoreAnEmptyPage(t *testing.T) {
	db, counter := countingTestDB(t)
	handler := &Handler{DB: db}
	counter.reset()
	handler.attachReactions(nil, 1)
	handler.attachPolls(nil, 1)
	handler.attachEvents(nil)
	if total := counter.countMatching("SELECT"); total != 0 {
		t.Fatalf("an empty page must not query anything, got %d statements", total)
	}
}

func TestExpirySweepIsThrottledPerConversation(t *testing.T) {
	sweeper := newExpirySweeper(30 * time.Second)
	base := time.Now()
	if !sweeper.due(1, base) {
		t.Fatal("the first sweep of a conversation must run")
	}
	if sweeper.due(1, base.Add(time.Second)) {
		t.Fatal("a sweep inside the interval must be skipped")
	}
	if !sweeper.due(2, base.Add(time.Second)) {
		t.Fatal("another conversation must sweep independently")
	}
	if !sweeper.due(1, base.Add(30*time.Second)) {
		t.Fatal("a sweep past the interval must run again")
	}
}

// TestExpiredMessagesStayHiddenBetweenSweeps is the safety net for throttling
// the sweep: a message past its expiry must never be returned, even when the
// physical delete has not run yet.
func TestExpiredMessagesStayHiddenBetweenSweeps(t *testing.T) {
	db, _ := countingTestDB(t)
	handler := &Handler{DB: db, ExpirySweepInterval: time.Hour}
	seedConversation(t, db, 2)
	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	mustExec(t, db, `UPDATE messages SET expires_at=? WHERE id=2`, past)

	// Run the sweep once so the throttle is armed, then expire another message
	// and confirm it is filtered out by the read path alone.
	handler.deleteExpired(1)
	mustExec(t, db, `UPDATE messages SET expires_at=? WHERE id=1`, past)

	page := loadPage(t, handler, 50)
	if len(page) != 0 {
		t.Fatalf("expired messages leaked into the page: %#v", page)
	}
	var remaining int
	if err := db.QueryRow(`SELECT COUNT(*) FROM messages WHERE id=1`).Scan(&remaining); err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatal("the throttled sweep should not have deleted the row yet; the filter alone must hide it")
	}
}

func loadPage(t *testing.T, handler *Handler, limit int) []Message {
	t.Helper()
	messages, err := listPageForTest(handler, 1, 1, limit)
	if err != nil {
		t.Fatal(err)
	}
	return messages
}

func seedConversation(t *testing.T, db *sql.DB, messages int) {
	t.Helper()
	now := time.Now().UTC().Add(-time.Hour)
	created := now.Format(time.RFC3339Nano)
	for _, user := range []struct {
		id   int64
		name string
	}{{1, "reader"}, {2, "writer"}} {
		mustExec(t, db, `INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
			VALUES(?,?,?,?,?,?,?,?)`, user.id, user.name, user.name, "hash", "public", "private", "salt", created)
	}
	mustExec(t, db, `INSERT INTO conversations(id,type,created_by,created_at) VALUES(1,'private',1,?)`, created)
	mustExec(t, db, `INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(1,1,'key','owner',?),(1,2,'key','member',?)`, created, created)
	for index := 1; index <= messages; index++ {
		at := now.Add(time.Duration(index) * time.Second).Format(time.RFC3339Nano)
		mustExec(t, db, `INSERT INTO messages(id,conversation_id,sender_id,encrypted_content,iv,key_epoch,created_at,message_kind,revision)
			VALUES(?,1,2,?,?,1,?, 'text',1)`, index, fmt.Sprintf("ciphertext-%d", index), "iv-value", at)
		mustExec(t, db, `INSERT INTO message_receipts(message_id,user_id,status,created_at) VALUES(?,1,'delivered',?),(?,2,'read',?)`,
			index, at, index, at)
	}
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
}

func countingTestDB(t *testing.T) (*sql.DB, *queryCounter) {
	t.Helper()
	counter := &queryCounter{}
	path := filepath.Join(t.TempDir(), "chat.db")
	db, err := database.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	counted, err := openCountingDatabase(path, counter)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { counted.Close() })
	return counted, counter
}
