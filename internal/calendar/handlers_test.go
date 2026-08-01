package calendar

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

func TestFeedRequiresBasicAuthenticationAndListsAccessibleEvents(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	authHandler := &auth.Handler{DB: db}
	registerCalendarUser(t, authHandler, "calendar_owner")
	now := time.Now().UTC().Truncate(time.Second)
	start := now.Add(time.Hour)
	end := start.Add(90 * time.Minute)
	conversation, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('private',1,?)`, now.Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	conversationID, _ := conversation.LastInsertId()
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'key','owner',?)`, conversationID, now.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	message, err := db.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,created_at)
		VALUES(?,1,'encrypted-event-content','event-iv',?)`, conversationID, now.Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	messageID, _ := message.LastInsertId()
	if _, err := db.Exec(`INSERT INTO message_events(message_id,starts_at,ends_at) VALUES(?,?,?)`,
		messageID, start.Format(time.RFC3339Nano), end.Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}

	handler := &Handler{DB: db}
	unauthenticated := httptest.NewRecorder()
	handler.Feed(unauthenticated, httptest.NewRequest(http.MethodGet, "/api/calendar.ics", nil))
	if unauthenticated.Code != http.StatusUnauthorized || !strings.HasPrefix(unauthenticated.Header().Get("WWW-Authenticate"), "Basic ") {
		t.Fatalf("unauthenticated status=%d challenge=%q", unauthenticated.Code, unauthenticated.Header().Get("WWW-Authenticate"))
	}

	wrongPassword := httptest.NewRequest(http.MethodGet, "/api/calendar.ics", nil)
	wrongPassword.SetBasicAuth("calendar_owner", "wrong-password")
	wrongResponse := httptest.NewRecorder()
	handler.Feed(wrongResponse, wrongPassword)
	if wrongResponse.Code != http.StatusUnauthorized {
		t.Fatalf("wrong password status=%d body=%s", wrongResponse.Code, wrongResponse.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "/api/calendar.ics", nil)
	request.Header.Set("Accept-Language", "fr-FR,fr;q=0.9")
	request.SetBasicAuth("calendar_owner", "Password123!")
	response := httptest.NewRecorder()
	handler.Feed(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/calendar; charset=utf-8" {
		t.Fatalf("feed status=%d type=%q body=%s", response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
	body := response.Body.String()
	for _, expected := range []string{
		"BEGIN:VCALENDAR\r\n",
		"BEGIN:VEVENT\r\n",
		"SUMMARY:Évènement Vibration\r\n",
		"DTSTART:" + start.UTC().Format("20060102T150405Z") + "\r\n",
		"DTEND:" + end.UTC().Format("20060102T150405Z") + "\r\n",
		"END:VEVENT\r\nEND:VCALENDAR\r\n",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("feed missing %q in %q", expected, body)
		}
	}
	if strings.Contains(body, "encrypted-event-content") {
		t.Fatal("feed exposed encrypted message content")
	}
}

func TestSharedFeedPublishesDecryptedSnapshotAndCanBeRevoked(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	authHandler := &auth.Handler{DB: db}
	cookie := registerCalendarUser(t, authHandler, "shared_calendar_owner")
	handler := &Handler{DB: db}
	mux := http.NewServeMux()
	mux.Handle("POST /api/calendar/feeds", authHandler.Middleware(http.HandlerFunc(handler.CreateSharedFeed)))
	mux.Handle("DELETE /api/calendar/feeds/{id}", authHandler.Middleware(http.HandlerFunc(handler.RevokeSharedFeed)))
	mux.Handle("GET /api/calendar-feed/{token}/calendar.ics", http.HandlerFunc(handler.SharedFeed))
	snapshot := "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Réunion\r\nDESCRIPTION:Description privée publiée\r\nLOCATION:Bureau 4\r\nDTSTART:20260801T100000Z\r\nDTEND:20260801T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
	body, _ := json.Marshal(map[string]string{"password": "Password123!", "snapshot": snapshot})
	create := httptest.NewRequest(http.MethodPost, "/api/calendar/feeds", bytes.NewReader(body))
	create.Header.Set("Content-Type", "application/json")
	create.AddCookie(cookie)
	created := httptest.NewRecorder()
	mux.ServeHTTP(created, create)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var result struct {
		ID    int64  `json:"id"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil || result.ID <= 0 || result.Token == "" {
		t.Fatalf("invalid create response: %s", created.Body.String())
	}

	feedRequest := httptest.NewRequest(http.MethodGet, "/api/calendar-feed/"+result.Token+"/calendar.ics", nil)
	feedRequest.SetBasicAuth("shared_calendar_owner", "Password123!")
	feed := httptest.NewRecorder()
	mux.ServeHTTP(feed, feedRequest)
	if feed.Code != http.StatusOK || feed.Header().Get("Content-Type") != "text/calendar; charset=utf-8" {
		t.Fatalf("feed status=%d type=%q body=%s", feed.Code, feed.Header().Get("Content-Type"), feed.Body.String())
	}
	for _, expected := range []string{"SUMMARY:Réunion", "DESCRIPTION:Description privée publiée", "LOCATION:Bureau 4"} {
		if !strings.Contains(feed.Body.String(), expected) {
			t.Fatalf("feed missing %q in %q", expected, feed.Body.String())
		}
	}

	revoke := httptest.NewRequest(http.MethodDelete, "/api/calendar/feeds/"+strconv.FormatInt(result.ID, 10), nil)
	revoke.AddCookie(cookie)
	revoked := httptest.NewRecorder()
	mux.ServeHTTP(revoked, revoke)
	if revoked.Code != http.StatusOK {
		t.Fatalf("revoke status=%d body=%s", revoked.Code, revoked.Body.String())
	}
	feedAfterRevoke := httptest.NewRecorder()
	mux.ServeHTTP(feedAfterRevoke, feedRequest)
	if feedAfterRevoke.Code != http.StatusNotFound {
		t.Fatalf("revoked feed status=%d body=%s", feedAfterRevoke.Code, feedAfterRevoke.Body.String())
	}
}

func registerCalendarUser(t *testing.T, handler *auth.Handler, username string) *http.Cookie {
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
	if len(response.Result().Cookies()) == 0 {
		t.Fatal("registration did not create a session cookie")
	}
	return response.Result().Cookies()[0]
}
