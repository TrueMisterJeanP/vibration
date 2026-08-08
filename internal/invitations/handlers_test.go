package invitations

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

func TestInvitationLifecycleAndPublicLanding(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	adminCookie := registerAdmin(t, authHandler)
	handler := &Handler{DB: db}

	mux := http.NewServeMux()
	mux.Handle("POST /api/admin/invitations", authHandler.AdminAccessMiddleware(http.HandlerFunc(handler.Create)))
	mux.Handle("GET /api/admin/invitations", authHandler.AdminAccessMiddleware(http.HandlerFunc(handler.List)))
	mux.Handle("DELETE /api/admin/invitations/{id}", authHandler.AdminAccessMiddleware(http.HandlerFunc(handler.Revoke)))
	mux.HandleFunc("GET /invite/{code}", handler.Landing)

	request := httptest.NewRequest(http.MethodPost, "/api/admin/invitations", bytes.NewBufferString(`{
		"first_name":"Jean",
		"last_name":"Dupont",
		"email":"jean@example.com",
		"code":"Famille-2026",
		"expires_in_seconds":86400
	}`))
	request.Header.Set("Content-Type", "application/json")
	request.Host = "chat.example.com"
	request.Header.Set("X-Forwarded-Proto", "https")
	request.AddCookie(adminCookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
	}
	var created struct {
		ID   int64  `json:"id"`
		Code string `json:"code"`
		URL  string `json:"url"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Code != "famille-2026" || created.URL != "https://chat.example.com/invite/famille-2026" {
		t.Fatalf("unexpected invitation response: %+v", created)
	}

	landing := httptest.NewRecorder()
	mux.ServeHTTP(landing, httptest.NewRequest(http.MethodGet, "/invite/famille-2026", nil))
	if landing.Code != http.StatusSeeOther || landing.Header().Get("Location") != "/login.html?mode=register&invitation=famille-2026" {
		t.Fatalf("landing status=%d location=%q", landing.Code, landing.Header().Get("Location"))
	}

	list := httptest.NewRecorder()
	listRequest := httptest.NewRequest(http.MethodGet, "/api/admin/invitations", nil)
	listRequest.AddCookie(adminCookie)
	mux.ServeHTTP(list, listRequest)
	if list.Code != http.StatusOK || bytes.Contains(list.Body.Bytes(), []byte("famille-2026")) {
		t.Fatalf("list should not expose the code: status=%d body=%s", list.Code, list.Body.String())
	}
	pagedList := httptest.NewRecorder()
	pagedListRequest := httptest.NewRequest(http.MethodGet, "/api/admin/invitations?page=1&limit=10", nil)
	pagedListRequest.AddCookie(adminCookie)
	mux.ServeHTTP(pagedList, pagedListRequest)
	var page struct {
		Items      []invitationRecord `json:"items"`
		Page       int                `json:"page"`
		Total      int                `json:"total"`
		TotalPages int                `json:"total_pages"`
	}
	if pagedList.Code != http.StatusOK || json.Unmarshal(pagedList.Body.Bytes(), &page) != nil ||
		page.Page != 1 || page.Total != 1 || page.TotalPages != 1 || len(page.Items) != 1 {
		t.Fatalf("unexpected paginated invitation list: status=%d body=%s", pagedList.Code, pagedList.Body.String())
	}

	revoke := httptest.NewRecorder()
	revokeRequest := httptest.NewRequest(http.MethodDelete, "/api/admin/invitations/"+itoa(created.ID), nil)
	revokeRequest.AddCookie(adminCookie)
	mux.ServeHTTP(revoke, revokeRequest)
	if revoke.Code != http.StatusOK {
		t.Fatalf("revoke status=%d body=%s", revoke.Code, revoke.Body.String())
	}
	afterRevoke := httptest.NewRecorder()
	mux.ServeHTTP(afterRevoke, httptest.NewRequest(http.MethodGet, "/invite/famille-2026", nil))
	if afterRevoke.Code != http.StatusGone {
		t.Fatalf("revoked landing status=%d body=%s", afterRevoke.Code, afterRevoke.Body.String())
	}
}

func TestInvitationPaginationBounds(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/admin/invitations?page=99&limit=10", nil)
	page, limit, offset, totalPages := invitationPagination(request, 23)
	if page != 3 || limit != 10 || offset != 20 || totalPages != 3 {
		t.Fatalf("unexpected invitation pagination: page=%d limit=%d offset=%d pages=%d", page, limit, offset, totalPages)
	}
}

func registerAdmin(t *testing.T, handler *auth.Handler) *http.Cookie {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewBufferString(`{
		"username":"first_admin",
		"display_name":"First Admin",
		"password":"Password123!",
		"public_key":"public-key-placeholder-value",
		"encrypted_private_key":"encrypted-private-key-value",
		"crypto_salt":"crypto-salt-value"
	}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.Register(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("admin registration status=%d body=%s", response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("admin registration did not create a session cookie")
	}
	return cookies[0]
}

func itoa(value int64) string {
	return strconv.FormatInt(value, 10)
}
