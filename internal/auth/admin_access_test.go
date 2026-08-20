package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"chat-pwa-go/internal/adminaccess"
	database "chat-pwa-go/internal/db"
)

func TestMeAndAdminMiddlewareApplyIPAddressPolicy(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}
	registration := registerRequest(t, handler, "ip_policy_admin")
	if registration.Code != http.StatusCreated {
		t.Fatalf("registration status=%d body=%s", registration.Code, registration.Body.String())
	}
	cookies := registration.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("registration did not set a session cookie")
	}
	if _, err := adminaccess.Save(db, adminaccess.Policy{Mode: adminaccess.ModeLocal}); err != nil {
		t.Fatal(err)
	}
	managerRegistration := registerRequest(t, handler, "ip_policy_manager")
	managerCookies := managerRegistration.Result().Cookies()
	if managerRegistration.Code != http.StatusCreated || len(managerCookies) == 0 {
		t.Fatalf("manager registration status=%d body=%s", managerRegistration.Code, managerRegistration.Body.String())
	}
	if _, err := db.Exec(`UPDATE users SET is_manager=1 WHERE username='ip_policy_manager'`); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("GET /api/me", handler.Middleware(http.HandlerFunc(handler.Me)))
	mux.Handle("GET /api/admin/protected", handler.AdminMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})))
	mux.Handle("GET /api/management/protected", handler.AdminAccessMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})))

	publicMe := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	publicMe.RemoteAddr = "203.0.113.40:443"
	publicMe.AddCookie(cookies[0])
	publicMeResponse := httptest.NewRecorder()
	mux.ServeHTTP(publicMeResponse, publicMe)
	var me User
	if err := json.Unmarshal(publicMeResponse.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if publicMeResponse.Code != http.StatusOK || me.AdminAccessAllowed {
		t.Fatalf("public /api/me status=%d me=%+v", publicMeResponse.Code, me)
	}

	publicAdmin := httptest.NewRequest(http.MethodGet, "/api/admin/protected", nil)
	publicAdmin.RemoteAddr = "203.0.113.40:443"
	publicAdmin.AddCookie(cookies[0])
	publicAdminResponse := httptest.NewRecorder()
	mux.ServeHTTP(publicAdminResponse, publicAdmin)
	if publicAdminResponse.Code != http.StatusForbidden {
		t.Fatalf("public administration status=%d body=%s", publicAdminResponse.Code, publicAdminResponse.Body.String())
	}
	publicManagement := httptest.NewRequest(http.MethodGet, "/api/management/protected", nil)
	publicManagement.RemoteAddr = "203.0.113.41:443"
	publicManagement.AddCookie(managerCookies[0])
	publicManagementResponse := httptest.NewRecorder()
	mux.ServeHTTP(publicManagementResponse, publicManagement)
	if publicManagementResponse.Code != http.StatusForbidden {
		t.Fatalf("public management status=%d body=%s", publicManagementResponse.Code, publicManagementResponse.Body.String())
	}

	localMe := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	localMe.RemoteAddr = "192.168.1.40:443"
	localMe.AddCookie(cookies[0])
	localMeResponse := httptest.NewRecorder()
	mux.ServeHTTP(localMeResponse, localMe)
	if err := json.Unmarshal(localMeResponse.Body.Bytes(), &me); err != nil {
		t.Fatal(err)
	}
	if localMeResponse.Code != http.StatusOK || !me.AdminAccessAllowed {
		t.Fatalf("local /api/me status=%d me=%+v", localMeResponse.Code, me)
	}

	localAdmin := httptest.NewRequest(http.MethodGet, "/api/admin/protected", nil)
	localAdmin.RemoteAddr = "192.168.1.40:443"
	localAdmin.AddCookie(cookies[0])
	localAdminResponse := httptest.NewRecorder()
	mux.ServeHTTP(localAdminResponse, localAdmin)
	if localAdminResponse.Code != http.StatusNoContent {
		t.Fatalf("local administration status=%d body=%s", localAdminResponse.Code, localAdminResponse.Body.String())
	}
	localManagement := httptest.NewRequest(http.MethodGet, "/api/management/protected", nil)
	localManagement.RemoteAddr = "192.168.1.41:443"
	localManagement.AddCookie(managerCookies[0])
	localManagementResponse := httptest.NewRecorder()
	mux.ServeHTTP(localManagementResponse, localManagement)
	if localManagementResponse.Code != http.StatusNoContent {
		t.Fatalf("local management status=%d body=%s", localManagementResponse.Code, localManagementResponse.Body.String())
	}
}
