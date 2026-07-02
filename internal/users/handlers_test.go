package users

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

func TestUpdateProfileAndPassword(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	authHandler := &auth.Handler{DB: db}
	userHandler := &Handler{DB: db}
	cookie := registerUser(t, authHandler)

	mux := http.NewServeMux()
	mux.Handle("PUT /api/me", authHandler.Middleware(http.HandlerFunc(userHandler.UpdateProfile)))

	updateBody := bytes.NewBufferString(`{
		"username":"renamed_user",
		"display_name":"Nouveau nom",
		"description":"Disponible pour discuter de nouveaux projets.",
		"current_password":"Password123!",
		"new_password":"NewPassword456!",
		"avatar":"data:image/png;base64,aGVsbG8="
	}`)
	update := httptest.NewRequest(http.MethodPut, "/api/me", updateBody)
	update.Header.Set("Content-Type", "application/json")
	update.AddCookie(cookie)
	updateResponse := httptest.NewRecorder()
	mux.ServeHTTP(updateResponse, update)
	if updateResponse.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", updateResponse.Code, updateResponse.Body.String())
	}

	var displayName, description, avatar string
	if err := db.QueryRow(`SELECT display_name,description,avatar FROM users WHERE username='renamed_user'`).Scan(&displayName, &description, &avatar); err != nil {
		t.Fatal(err)
	}
	if displayName != "Nouveau nom" {
		t.Fatalf("display_name=%q", displayName)
	}
	if avatar != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("avatar=%q", avatar)
	}
	if description != "Disponible pour discuter de nouveaux projets." {
		t.Fatalf("description=%q", description)
	}

	loginBody := bytes.NewBufferString(`{"username":"renamed_user","password":"NewPassword456!"}`)
	login := httptest.NewRequest(http.MethodPost, "/api/login", loginBody)
	login.Header.Set("Content-Type", "application/json")
	loginResponse := httptest.NewRecorder()
	authHandler.Login(loginResponse, login)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("new password login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
}

func TestUpdateProfileRejectsWrongCurrentPassword(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	authHandler := &auth.Handler{DB: db}
	userHandler := &Handler{DB: db}
	cookie := registerUser(t, authHandler)
	mux := http.NewServeMux()
	mux.Handle("PUT /api/me", authHandler.Middleware(http.HandlerFunc(userHandler.UpdateProfile)))

	body := bytes.NewBufferString(`{
		"username":"renamed_user",
		"display_name":"Nouveau nom",
		"current_password":"incorrect",
		"new_password":"NewPassword456!"
	}`)
	request := httptest.NewRequest(http.MethodPut, "/api/me", body)
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestUpdateProfileRejectsDuplicateDisplayName(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	authHandler := &auth.Handler{DB: db}
	userHandler := &Handler{DB: db}
	cookie := registerUserNamed(t, authHandler, "profile_user")
	_ = registerUserNamed(t, authHandler, "profile_peer")
	mux := http.NewServeMux()
	mux.Handle("PUT /api/me", authHandler.Middleware(http.HandlerFunc(userHandler.UpdateProfile)))

	body := bytes.NewBufferString(`{
		"username":"profile_user",
		"display_name":"PROFILE_PEER",
		"description":""
	}`)
	request := httptest.NewRequest(http.MethodPut, "/api/me", body)
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestUpdateProfileNotifiesConversationMembers(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	authHandler := &auth.Handler{DB: db}
	hub := &profileEventHub{events: make(map[int64][]map[string]any)}
	userHandler := &Handler{DB: db, Hub: hub}
	cookie := registerUser(t, authHandler)
	_ = registerUserNamed(t, authHandler, "profile_peer")
	if _, err := db.Exec(`INSERT INTO conversations(id,type,created_by,created_at) VALUES(1,'private',1,'2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []int64{1, 2} {
		if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,created_at)
			VALUES(1,?,?, '2026-01-01T00:00:00Z')`, userID, "ecdh-v1"); err != nil {
			t.Fatal(err)
		}
	}

	mux := http.NewServeMux()
	mux.Handle("PUT /api/me", authHandler.Middleware(http.HandlerFunc(userHandler.UpdateProfile)))
	body := bytes.NewBufferString(`{
		"username":"profile_user",
		"display_name":"Profil",
		"description":"Nouvel avatar",
		"avatar":"data:image/png;base64,aGVsbG8="
	}`)
	request := httptest.NewRequest(http.MethodPut, "/api/me", body)
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	for _, userID := range []int64{1, 2} {
		events := hub.events[userID]
		if len(events) != 1 {
			t.Fatalf("user %d events=%d", userID, len(events))
		}
		if events[0]["type"] != "conversation_updated" || events[0]["conversation_id"] != int64(1) ||
			events[0]["profile_updated"] != true || events[0]["user_id"] != int64(1) {
			t.Fatalf("unexpected event for user %d: %#v", userID, events[0])
		}
	}
}

type profileEventHub struct {
	events map[int64][]map[string]any
}

func (h *profileEventHub) SendToUser(userID int64, event any) bool {
	value, ok := event.(map[string]any)
	if !ok {
		return false
	}
	h.events[userID] = append(h.events[userID], value)
	return true
}

func registerUser(t *testing.T, handler *auth.Handler) *http.Cookie {
	return registerUserNamed(t, handler, "profile_user")
}

func registerUserNamed(t *testing.T, handler *auth.Handler, username string) *http.Cookie {
	t.Helper()
	payload := map[string]string{
		"username": username, "display_name": username, "password": "Password123!",
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
	cookies := response.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("registration did not set a session cookie")
	}
	return cookies[0]
}
