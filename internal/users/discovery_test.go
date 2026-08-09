package users

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"testing"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

func TestInvisibleProfileRequiresPrivateDiscoveryCode(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	authHandler := &auth.Handler{DB: db}
	userHandler := &Handler{DB: db}
	seeker := registerUserNamed(t, authHandler, "discovery_seeker")
	hidden := registerUserNamed(t, authHandler, "discovery_hidden")
	visible := registerUserNamed(t, authHandler, "discovery_visible")
	if _, err := db.Exec(`UPDATE users SET is_discoverable=0 WHERE id=2`); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("GET /api/me", authHandler.Middleware(http.HandlerFunc(authHandler.Me)))
	mux.Handle("POST /api/me/discovery-code", authHandler.Middleware(http.HandlerFunc(userHandler.GenerateDiscoveryCode)))
	mux.Handle("GET /api/users/search", authHandler.Middleware(http.HandlerFunc(userHandler.Search)))
	mux.Handle("POST /api/users/search", authHandler.Middleware(http.HandlerFunc(userHandler.Search)))

	if users := searchUsers(t, mux, seeker, "discovery_hidden"); len(users) != 0 {
		t.Fatalf("invisible user leaked by username: %+v", users)
	}
	if users := searchUsers(t, mux, seeker, "discovery_visible"); len(users) != 1 || users[0].ID != 3 {
		t.Fatalf("visible user missing from directory: %+v", users)
	}

	generated := discoveryRequest(t, mux, hidden, "/api/me/discovery-code", map[string]string{"password": "Password123!"})
	if generated.Code != http.StatusOK {
		t.Fatalf("generate status=%d body=%s", generated.Code, generated.Body.String())
	}
	var codeResponse struct {
		DiscoveryCode string `json:"discovery_code"`
	}
	if err := json.Unmarshal(generated.Body.Bytes(), &codeResponse); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^VIB-(?:[A-Z2-7]{4}-){7}[A-Z2-7]{4}$`).MatchString(codeResponse.DiscoveryCode) {
		t.Fatalf("unexpected discovery code format %q", codeResponse.DiscoveryCode)
	}
	var storedHash string
	if err := db.QueryRow(`SELECT discovery_code_hash FROM users WHERE id=2`).Scan(&storedHash); err != nil {
		t.Fatal(err)
	}
	if storedHash == "" || storedHash == codeResponse.DiscoveryCode {
		t.Fatalf("clear discovery code stored in database: %q", storedHash)
	}
	if users := searchUsers(t, mux, seeker, codeResponse.DiscoveryCode); len(users) != 1 || users[0].ID != 2 || users[0].Username != "discovery_hidden" {
		t.Fatalf("valid code did not resolve hidden user: %+v", users)
	}

	previousCode := codeResponse.DiscoveryCode
	rotated := discoveryRequest(t, mux, hidden, "/api/me/discovery-code", map[string]string{"password": "Password123!"})
	if rotated.Code != http.StatusOK {
		t.Fatalf("rotate status=%d body=%s", rotated.Code, rotated.Body.String())
	}
	if err := json.Unmarshal(rotated.Body.Bytes(), &codeResponse); err != nil {
		t.Fatal(err)
	}
	if codeResponse.DiscoveryCode == previousCode {
		t.Fatal("rotating a private discovery code returned the previous code")
	}
	if users := searchUsers(t, mux, seeker, previousCode); len(users) != 0 {
		t.Fatalf("previous code remained valid after rotation: %+v", users)
	}

	replacement := "A"
	if codeResponse.DiscoveryCode[len(codeResponse.DiscoveryCode)-1:] == replacement {
		replacement = "B"
	}
	wrongCode := codeResponse.DiscoveryCode[:len(codeResponse.DiscoveryCode)-1] + replacement
	if users := searchUsers(t, mux, seeker, wrongCode); len(users) != 0 {
		t.Fatalf("wrong code resolved a user: %+v", users)
	}
	if users := searchUsers(t, mux, seeker, codeResponse.DiscoveryCode); len(users) != 1 || users[0].ID != 2 || users[0].Username != "discovery_hidden" {
		t.Fatalf("rotated code did not resolve hidden user: %+v", users)
	}
	getWithCode := httptest.NewRequest(http.MethodGet, "/api/users/search?q="+codeResponse.DiscoveryCode, nil)
	getWithCode.AddCookie(seeker)
	getWithCodeResponse := httptest.NewRecorder()
	mux.ServeHTTP(getWithCodeResponse, getWithCode)
	if getWithCodeResponse.Code != http.StatusOK || getWithCodeResponse.Body.String() != "[]\n" {
		t.Fatalf("secret code accepted in URL: status=%d body=%s", getWithCodeResponse.Code, getWithCodeResponse.Body.String())
	}

	if _, err := db.Exec(`INSERT INTO contacts(owner_id,contact_user_id,status,created_at) VALUES(1,2,'accepted','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if users := searchUsers(t, mux, seeker, "discovery_hidden"); len(users) != 1 || users[0].ID != 2 {
		t.Fatalf("known hidden contact should remain searchable: %+v", users)
	}

	visibleGeneration := discoveryRequest(t, mux, visible, "/api/me/discovery-code", map[string]string{"password": "Password123!"})
	if visibleGeneration.Code != http.StatusConflict {
		t.Fatalf("visible profile generated a private code: status=%d body=%s", visibleGeneration.Code, visibleGeneration.Body.String())
	}

	meRequest := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	meRequest.AddCookie(hidden)
	meResponse := httptest.NewRecorder()
	mux.ServeHTTP(meResponse, meRequest)
	var me struct {
		IsDiscoverable   bool `json:"is_discoverable"`
		HasDiscoveryCode bool `json:"has_discovery_code"`
	}
	if err := json.Unmarshal(meResponse.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if me.IsDiscoverable || !me.HasDiscoveryCode {
		t.Fatalf("unexpected private profile state: %+v", me)
	}
}

func searchUsers(t *testing.T, mux http.Handler, cookie *http.Cookie, query string) []User {
	t.Helper()
	response := discoveryRequest(t, mux, cookie, "/api/users/search", map[string]string{"query": query})
	if response.Code != http.StatusOK {
		t.Fatalf("search status=%d body=%s", response.Code, response.Body.String())
	}
	var users []User
	if err := json.Unmarshal(response.Body.Bytes(), &users); err != nil {
		t.Fatal(err)
	}
	return users
}

func discoveryRequest(t *testing.T, mux http.Handler, cookie *http.Cookie, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	return response
}
