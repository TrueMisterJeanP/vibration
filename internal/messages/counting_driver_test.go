package messages

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"chat-pwa-go/internal/auth"
)

// countingDriver forwards to the sqlite driver while recording every statement
// the handler issues, which is what makes the "bounded queries per page"
// property testable.
type countingDriver struct {
	counter *queryCounter
}

var countingDriverSequence atomic.Int64

func openCountingDatabase(path string, counter *queryCounter) (*sql.DB, error) {
	name := fmt.Sprintf("sqlite-counting-%d", countingDriverSequence.Add(1))
	sql.Register(name, &countingDriver{counter: counter})
	database, err := sql.Open(name, path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	return database, database.Ping()
}

func (d *countingDriver) Open(name string) (driver.Conn, error) {
	base, err := sqliteDriver().Open(name)
	if err != nil {
		return nil, err
	}
	return &countingConn{Conn: base, counter: d.counter}, nil
}

// sqliteDriver borrows the driver already registered by internal/db.
func sqliteDriver() driver.Driver {
	database, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		panic(err)
	}
	defer database.Close()
	return database.Driver()
}

type countingConn struct {
	driver.Conn
	counter *queryCounter
}

func (c *countingConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	c.counter.record(query)
	queryer, ok := c.Conn.(driver.QueryerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	return queryer.QueryContext(ctx, query, args)
}

func (c *countingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	c.counter.record(query)
	execer, ok := c.Conn.(driver.ExecerContext)
	if !ok {
		return nil, driver.ErrSkip
	}
	return execer.ExecContext(ctx, query, args)
}

func (c *countingConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	c.counter.record(query)
	preparer, ok := c.Conn.(driver.ConnPrepareContext)
	if !ok {
		return c.Conn.Prepare(query)
	}
	return preparer.PrepareContext(ctx, query)
}

func (c *countingConn) BeginTx(ctx context.Context, opts driver.TxOptions) (driver.Tx, error) {
	beginner, ok := c.Conn.(driver.ConnBeginTx)
	if !ok {
		return c.Conn.Begin()
	}
	return beginner.BeginTx(ctx, opts)
}

// listPageForTest drives Handler.List through the real routing and
// authentication middleware, so the measured statements are exactly those a
// browser request produces.
func listPageForTest(handler *Handler, conversationID, userID int64, limit int) ([]Message, error) {
	authHandler := &auth.Handler{DB: handler.DB}
	if err := ensureTestSession(handler.DB, userID); err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.Handle("GET /api/conversations/{id}/messages", authHandler.Middleware(http.HandlerFunc(handler.List)))
	request := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/api/conversations/%d/messages?limit=%d", conversationID, limit), nil)
	request.Header.Set("Authorization", "Bearer "+testSessionToken(userID))
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		return nil, fmt.Errorf("list messages: status %d: %s", recorder.Code, recorder.Body.String())
	}
	var messages []Message
	if err := json.Unmarshal(recorder.Body.Bytes(), &messages); err != nil {
		return nil, err
	}
	return messages, nil
}

func testSessionToken(userID int64) string {
	return fmt.Sprintf("test-session-%d", userID)
}

func ensureTestSession(db *sql.DB, userID int64) error {
	var exists int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id=?`, testSessionToken(userID)).Scan(&exists); err != nil {
		return err
	}
	if exists > 0 {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	expires := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	_, err := db.Exec(`INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at,approved_at) VALUES(?,?,?,?,?,?)`,
		testSessionToken(userID), userID, expires, now, now, now)
	return err
}

func TestCountingDriverRecordsStatements(t *testing.T) {
	db, counter := countingTestDB(t)
	counter.reset()
	if _, err := db.Exec(`SELECT 1`); err != nil {
		t.Fatal(err)
	}
	if counter.countMatching("SELECT 1") != 1 {
		t.Fatal("the counting driver did not record the statement, so the query-count assertions would be vacuous")
	}
}
