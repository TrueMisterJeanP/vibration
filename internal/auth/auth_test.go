package auth

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	database "chat-pwa-go/internal/db"
	"chat-pwa-go/internal/settings"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestDisabledRegistrationStillAllowsInitialAdminOnly(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db, DisableRegistration: true}

	first := registerRequest(t, handler, "first_admin")
	if first.Code != http.StatusCreated {
		t.Fatalf("first registration status=%d body=%s", first.Code, first.Body.String())
	}
	second := registerRequest(t, handler, "second_user")
	if second.Code != http.StatusForbidden {
		t.Fatalf("second registration status=%d body=%s", second.Code, second.Body.String())
	}
}

func TestInvitationCodeIsRequiredAfterInitialAdminWhenConfigured(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	first := registerRequest(t, handler, "first_admin")
	if first.Code != http.StatusCreated {
		t.Fatalf("first registration status=%d body=%s", first.Code, first.Body.String())
	}
	if err := settings.SetInvitationCode(db, "invite-1234"); err != nil {
		t.Fatal(err)
	}
	denied := registerRequest(t, handler, "second_user")
	if denied.Code != http.StatusForbidden {
		t.Fatalf("missing code status=%d body=%s", denied.Code, denied.Body.String())
	}
	accepted := registerRequestWithInvitation(t, handler, "third_user", "invite-1234")
	if accepted.Code != http.StatusCreated {
		t.Fatalf("accepted status=%d body=%s", accepted.Code, accepted.Body.String())
	}
}

func TestInvitationCodeCanBeConfiguredButNotRequired(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	first := registerRequest(t, handler, "first_admin")
	if first.Code != http.StatusCreated {
		t.Fatalf("first registration status=%d body=%s", first.Code, first.Body.String())
	}
	if err := settings.SetInvitationCode(db, "invite-1234"); err != nil {
		t.Fatal(err)
	}
	if err := settings.SetInvitationCodeRequired(db, false); err != nil {
		t.Fatal(err)
	}
	second := registerRequest(t, handler, "second_user")
	if second.Code != http.StatusCreated {
		t.Fatalf("second registration status=%d body=%s", second.Code, second.Body.String())
	}
}

func TestRegistrationSettingsExposeInvitationRequirement(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	initial := httptest.NewRecorder()
	handler.RegistrationSettings(initial, httptest.NewRequest(http.MethodGet, "/api/registration", nil))
	if initial.Code != http.StatusOK {
		t.Fatalf("initial settings status=%d body=%s", initial.Code, initial.Body.String())
	}
	var initialSettings struct {
		InvitationCodeRequired bool `json:"invitation_code_required"`
	}
	if err := json.Unmarshal(initial.Body.Bytes(), &initialSettings); err != nil {
		t.Fatal(err)
	}
	if initialSettings.InvitationCodeRequired {
		t.Fatal("first registration should not require an invitation code")
	}

	if first := registerRequest(t, handler, "first_admin"); first.Code != http.StatusCreated {
		t.Fatalf("first registration status=%d body=%s", first.Code, first.Body.String())
	}
	if err := settings.SetInvitationCode(db, "invite-1234"); err != nil {
		t.Fatal(err)
	}
	if err := settings.SetInvitationCodeRequired(db, true); err != nil {
		t.Fatal(err)
	}
	required := httptest.NewRecorder()
	handler.RegistrationSettings(required, httptest.NewRequest(http.MethodGet, "/api/registration", nil))
	var requiredSettings struct {
		InvitationCodeRequired bool `json:"invitation_code_required"`
	}
	if err := json.Unmarshal(required.Body.Bytes(), &requiredSettings); err != nil {
		t.Fatal(err)
	}
	if !requiredSettings.InvitationCodeRequired {
		t.Fatal("registration settings should expose the required invitation code")
	}
}

func TestRecoveryCodeCanResetPassword(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	registered := registerRequest(t, handler, "recoverable_user")
	if registered.Code != http.StatusCreated {
		t.Fatalf("registration status=%d body=%s", registered.Code, registered.Body.String())
	}
	var registration struct {
		RecoveryCode string `json:"recovery_code"`
	}
	if err := json.Unmarshal(registered.Body.Bytes(), &registration); err != nil {
		t.Fatal(err)
	}
	if registration.RecoveryCode == "" {
		t.Fatal("registration did not return a recovery code")
	}

	reset := httptest.NewRequest(http.MethodPost, "/api/password/reset", bytes.NewBufferString(`{
		"username":"recoverable_user",
		"recovery_code":"`+registration.RecoveryCode+`",
		"new_password":"NewPassword456!"
	}`))
	reset.RemoteAddr = "127.0.0.1:12345"
	reset.Header.Set("Content-Type", "application/json")
	resetResponse := httptest.NewRecorder()
	handler.ResetPassword(resetResponse, reset)
	if resetResponse.Code != http.StatusOK {
		t.Fatalf("reset status=%d body=%s", resetResponse.Code, resetResponse.Body.String())
	}

	oldLogin := loginRequest(t, handler, "recoverable_user", "Password123!")
	if oldLogin.Code != http.StatusUnauthorized {
		t.Fatalf("old password login status=%d body=%s", oldLogin.Code, oldLogin.Body.String())
	}
	newLogin := loginRequest(t, handler, "recoverable_user", "NewPassword456!")
	if newLogin.Code != http.StatusOK {
		t.Fatalf("new password login status=%d body=%s", newLogin.Code, newLogin.Body.String())
	}
}

func TestRegisterRejectsDuplicateDisplayName(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	first := registerRequestWithDisplayName(t, handler, "first_user", "Same Name", "")
	if first.Code != http.StatusCreated {
		t.Fatalf("first registration status=%d body=%s", first.Code, first.Body.String())
	}
	second := registerRequestWithDisplayName(t, handler, "second_user", "same name", "")
	if second.Code != http.StatusConflict {
		t.Fatalf("duplicate display name status=%d body=%s", second.Code, second.Body.String())
	}
}

func TestRegisterRejectsDuplicateUsername(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	first := registerRequestWithDisplayName(t, handler, "same_user", "First User", "")
	if first.Code != http.StatusCreated {
		t.Fatalf("first registration status=%d body=%s", first.Code, first.Body.String())
	}
	second := registerRequestWithDisplayName(t, handler, "same_user", "Second User", "")
	if second.Code != http.StatusConflict {
		t.Fatalf("duplicate username status=%d body=%s", second.Code, second.Body.String())
	}
	if !bytes.Contains(second.Body.Bytes(), []byte("Ce nom d")) {
		t.Fatalf("duplicate username body=%s", second.Body.String())
	}
}

func TestRegisterDoesNotReportUsernameConflictForOtherInsertFailures(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TRIGGER fail_user_insert BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END`); err != nil {
		t.Fatal(err)
	}
	handler := &Handler{DB: db}

	response := registerRequestWithDisplayName(t, handler, "new_user", "New User", "")
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("insert failure status=%d body=%s", response.Code, response.Body.String())
	}
	if bytes.Contains(response.Body.Bytes(), []byte("Ce nom d")) {
		t.Fatalf("insert failure should not be reported as a username conflict: %s", response.Body.String())
	}
}

func TestRegistrationInsertErrorClassifiesUniqueConstraints(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		wantStatus  int
		wantMessage string
	}{
		{
			name:        "mysql username",
			err:         &mysql.MySQLError{Number: 1062, Message: "Duplicate entry 'same_user' for key 'username'"},
			wantStatus:  http.StatusConflict,
			wantMessage: "username already exists",
		},
		{
			name:        "postgres username",
			err:         &pgconn.PgError{Code: "23505", ConstraintName: "users_username_key"},
			wantStatus:  http.StatusConflict,
			wantMessage: "username already exists",
		},
		{
			name:        "postgres display name",
			err:         &pgconn.PgError{Code: "23505", ConstraintName: "users_display_name_key"},
			wantStatus:  http.StatusConflict,
			wantMessage: "display name already exists",
		},
		{
			name:        "unknown insert error",
			err:         &mysql.MySQLError{Number: 1406, Message: "Data too long for column 'public_key'"},
			wantStatus:  http.StatusInternalServerError,
			wantMessage: "registration failed",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status, message := registrationInsertError(test.err)
			if status != test.wantStatus || message != test.wantMessage {
				t.Fatalf("registrationInsertError()=(%d,%q), want (%d,%q)", status, message, test.wantStatus, test.wantMessage)
			}
		})
	}
}

func TestLoginRememberMeControlsSessionCookiePersistence(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	registered := registerRequest(t, handler, "session_user")
	if registered.Code != http.StatusCreated {
		t.Fatalf("registration status=%d body=%s", registered.Code, registered.Body.String())
	}
	shortLogin := loginRequestWithRemember(t, handler, "session_user", "Password123!", false)
	if shortLogin.Code != http.StatusOK {
		t.Fatalf("short login status=%d body=%s", shortLogin.Code, shortLogin.Body.String())
	}
	shortCookie := shortLogin.Result().Cookies()[0]
	if !shortCookie.Expires.IsZero() {
		t.Fatalf("short session should not set cookie Expires, got %s", shortCookie.Expires)
	}

	longLogin := loginRequestWithRemember(t, handler, "session_user", "Password123!", true)
	if longLogin.Code != http.StatusOK {
		t.Fatalf("long login status=%d body=%s", longLogin.Code, longLogin.Body.String())
	}
	longCookie := longLogin.Result().Cookies()[0]
	if longCookie.Expires.IsZero() {
		t.Fatal("remembered session should set cookie Expires")
	}
}

func registerRequest(t *testing.T, handler *Handler, username string) *httptest.ResponseRecorder {
	return registerRequestWithInvitation(t, handler, username, "")
}

func registerRequestWithInvitation(t *testing.T, handler *Handler, username, invitationCode string) *httptest.ResponseRecorder {
	return registerRequestWithDisplayName(t, handler, username, username, invitationCode)
}

func registerRequestWithDisplayName(t *testing.T, handler *Handler, username, displayName, invitationCode string) *httptest.ResponseRecorder {
	t.Helper()
	body := []byte(`{
		"username":"` + username + `",
		"display_name":"` + displayName + `",
		"password":"Password123!",
		"invitation_code":"` + invitationCode + `",
		"public_key":"public-key-placeholder-value",
		"encrypted_private_key":"encrypted-private-key-value",
		"crypto_salt":"crypto-salt-value"
	}`)
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	response := httptest.NewRecorder()
	handler.Register(response, request)
	return response
}

func loginRequest(t *testing.T, handler *Handler, username, password string) *httptest.ResponseRecorder {
	return loginRequestWithRemember(t, handler, username, password, false)
}

func loginRequestWithRemember(t *testing.T, handler *Handler, username, password string, rememberMe bool) *httptest.ResponseRecorder {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{"username": username, "password": password, "remember_me": rememberMe})
	request := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(payload))
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.Login(response, request)
	return response
}
