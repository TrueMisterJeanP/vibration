package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	database "chat-pwa-go/internal/db"
	"chat-pwa-go/internal/settings"
)

func TestTermsMustBeAcceptedAndAreVersioned(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}
	registered := registerRequest(t, handler, "terms_user")
	if registered.Code != http.StatusCreated {
		t.Fatalf("registration status=%d body=%s", registered.Code, registered.Body.String())
	}
	cookie := registered.Result().Cookies()[0]

	mux := http.NewServeMux()
	mux.Handle("GET /api/terms/status", handler.Middleware(http.HandlerFunc(handler.TermsStatus)))
	mux.Handle("POST /api/terms/accept", handler.Middleware(http.HandlerFunc(handler.AcceptTerms)))
	mux.Handle("GET /api/protected", handler.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})))
	server := handler.TermsMiddleware(mux)

	protected := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	protected.AddCookie(cookie)
	protectedResponse := httptest.NewRecorder()
	server.ServeHTTP(protectedResponse, protected)
	if protectedResponse.Code != http.StatusForbidden || !bytes.Contains(protectedResponse.Body.Bytes(), []byte("terms_acceptance_required")) {
		t.Fatalf("protected status=%d body=%s", protectedResponse.Code, protectedResponse.Body.String())
	}

	status := httptest.NewRequest(http.MethodGet, "/api/terms/status", nil)
	status.AddCookie(cookie)
	statusResponse := httptest.NewRecorder()
	server.ServeHTTP(statusResponse, status)
	var current struct {
		Content  string `json:"content"`
		Version  int64  `json:"version"`
		Accepted bool   `json:"accepted"`
	}
	if err := json.Unmarshal(statusResponse.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if current.Accepted || current.Version != 1 || !strings.Contains(strings.ToLower(current.Content), "bannir") {
		t.Fatalf("unexpected initial terms: %+v", current)
	}

	acceptBody, _ := json.Marshal(map[string]any{"version": current.Version, "accept": true})
	accept := httptest.NewRequest(http.MethodPost, "/api/terms/accept", bytes.NewReader(acceptBody))
	accept.Header.Set("Content-Type", "application/json")
	accept.AddCookie(cookie)
	acceptResponse := httptest.NewRecorder()
	server.ServeHTTP(acceptResponse, accept)
	if acceptResponse.Code != http.StatusOK {
		t.Fatalf("accept status=%d body=%s", acceptResponse.Code, acceptResponse.Body.String())
	}

	protected = httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	protected.AddCookie(cookie)
	protectedResponse = httptest.NewRecorder()
	server.ServeHTTP(protectedResponse, protected)
	if protectedResponse.Code != http.StatusNoContent {
		t.Fatalf("accepted protected status=%d body=%s", protectedResponse.Code, protectedResponse.Body.String())
	}

	updated, changed, err := settings.SaveTerms(db, current.Content+"\n\nNouvelle règle de modération applicable.")
	if err != nil || !changed || updated.Version != 2 {
		t.Fatalf("updated=%+v changed=%v err=%v", updated, changed, err)
	}
	protected = httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	protected.AddCookie(cookie)
	protectedResponse = httptest.NewRecorder()
	server.ServeHTTP(protectedResponse, protected)
	if protectedResponse.Code != http.StatusForbidden {
		t.Fatalf("new version protected status=%d body=%s", protectedResponse.Code, protectedResponse.Body.String())
	}
}
