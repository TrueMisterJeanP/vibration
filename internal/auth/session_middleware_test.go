package auth

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	database "chat-pwa-go/internal/db"
)

// TestMiddlewareThrottlesActivityWritesOnly proves the optimization is limited
// to the activity column: the session row itself is still read, and its
// expiry, approval and ban state still decided, on every request.
func TestMiddlewareThrottlesActivityWritesOnly(t *testing.T) {
	db := sessionMiddlewareTestDB(t)
	handler := &Handler{DB: db}
	guarded := handler.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	firstSeen := sessionLastSeen(t, db, "session-token")
	for attempt := 0; attempt < 20; attempt++ {
		if status := callGuarded(guarded, "session-token"); status != http.StatusOK {
			t.Fatalf("request %d: status=%d", attempt, status)
		}
	}
	afterBurst := sessionLastSeen(t, db, "session-token")
	if afterBurst == firstSeen {
		t.Fatal("the first request of a session must still record its activity")
	}
	for attempt := 0; attempt < 20; attempt++ {
		if status := callGuarded(guarded, "session-token"); status != http.StatusOK {
			t.Fatalf("request %d: status=%d", attempt, status)
		}
	}
	if sessionLastSeen(t, db, "session-token") != afterBurst {
		t.Fatal("twenty further requests inside the same minute must not rewrite last_seen_at")
	}
}

func TestMiddlewareStillRejectsBannedUserWhileThrottled(t *testing.T) {
	db := sessionMiddlewareTestDB(t)
	handler := &Handler{DB: db}
	guarded := handler.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	if status := callGuarded(guarded, "session-token"); status != http.StatusOK {
		t.Fatalf("warm-up status=%d", status)
	}
	if _, err := db.Exec(`UPDATE users SET is_banned=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	// The activity write is throttled at this point, which must not stop the
	// ban from being seen.
	if status := callGuarded(guarded, "session-token"); status != http.StatusForbidden {
		t.Fatalf("banned user status=%d, want 403", status)
	}
}

func TestMiddlewareStillRejectsExpiredSessionWhileThrottled(t *testing.T) {
	db := sessionMiddlewareTestDB(t)
	handler := &Handler{DB: db}
	guarded := handler.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	if status := callGuarded(guarded, "session-token"); status != http.StatusOK {
		t.Fatalf("warm-up status=%d", status)
	}
	past := time.Now().UTC().Add(-time.Hour).Format(time.RFC3339Nano)
	if _, err := db.Exec(`UPDATE sessions SET expires_at=? WHERE id=?`, past, "session-token"); err != nil {
		t.Fatal(err)
	}
	if status := callGuarded(guarded, "session-token"); status != http.StatusUnauthorized {
		t.Fatalf("expired session status=%d, want 401", status)
	}
}

func TestMiddlewareStillRejectsRevokedSessionWhileThrottled(t *testing.T) {
	db := sessionMiddlewareTestDB(t)
	handler := &Handler{DB: db}
	guarded := handler.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	if status := callGuarded(guarded, "session-token"); status != http.StatusOK {
		t.Fatalf("warm-up status=%d", status)
	}
	if _, err := db.Exec(`DELETE FROM sessions WHERE id=?`, "session-token"); err != nil {
		t.Fatal(err)
	}
	if status := callGuarded(guarded, "session-token"); status != http.StatusUnauthorized {
		t.Fatalf("revoked session status=%d, want 401", status)
	}
}

func TestMiddlewareStillRequiresApprovalWhileThrottled(t *testing.T) {
	db := sessionMiddlewareTestDB(t)
	handler := &Handler{DB: db}
	guarded := handler.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	if status := callGuarded(guarded, "session-token"); status != http.StatusOK {
		t.Fatalf("warm-up status=%d", status)
	}
	future := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	if _, err := db.Exec(`UPDATE sessions SET approved_at=NULL,approval_expires_at=? WHERE id=?`, future, "session-token"); err != nil {
		t.Fatal(err)
	}
	if status := callGuarded(guarded, "session-token"); status != http.StatusForbidden {
		t.Fatalf("unapproved session status=%d, want 403", status)
	}
}

func callGuarded(handler http.Handler, token string) int {
	request := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder.Code
}

func sessionLastSeen(t *testing.T, db *sql.DB, sessionID string) string {
	t.Helper()
	var lastSeen string
	if err := db.QueryRow(`SELECT last_seen_at FROM sessions WHERE id=?`, sessionID).Scan(&lastSeen); err != nil {
		t.Fatal(err)
	}
	return lastSeen
}

func sessionMiddlewareTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
		VALUES(1,'throttled','Throttled','hash','public','private','salt',?)`, now); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO sessions(id,user_id,expires_at,created_at,last_seen_at,approved_at)
		VALUES(?,1,?,?,?,?)`, "session-token", expires, now, now, now); err != nil {
		t.Fatal(err)
	}
	return db
}
