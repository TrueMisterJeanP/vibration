package auth

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	database "chat-pwa-go/internal/db"
	"chat-pwa-go/internal/invitationstore"
	"chat-pwa-go/internal/settings"
	"chat-pwa-go/internal/testsupport"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
)

func signTrustedDeviceTestChallenge(t *testing.T, challenge string) string {
	t.Helper()
	privateBytes, _ := base64.RawURLEncoding.DecodeString("0wrbBpHr-HCJFOx1IspTTMjBCiqpPk5OFMAslxZaTiQ")
	d := new(big.Int).SetBytes(privateBytes)
	x, y := elliptic.P256().ScalarBaseMult(privateBytes)
	key := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, D: d}
	digest := sha256.Sum256([]byte(challenge))
	r, s, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	raw := make([]byte, 64)
	r.FillBytes(raw[:32])
	s.FillBytes(raw[32:])
	return base64.StdEncoding.EncodeToString(raw)
}

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

func TestRegistrationRejectsLegacyIdentityEnvelope(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}
	payload := testRegistrationPayload("legacy_user", "Legacy User", "")
	payload["encrypted_private_key"] = `{"v":1,"iv":"AAAAAAAAAAAAAAAA","data":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`
	payload["crypto_salt"] = "AAAAAAAAAAAAAAAAAAAAAA=="
	body, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	response := httptest.NewRecorder()
	handler.Register(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("legacy registration status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestLegacyIdentityCanUpgradeOnceWithoutChangingEncryptionPublicKey(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}
	result, err := db.Exec(`INSERT INTO users(username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
		VALUES(?,?,?,?,?,?,?)`, "legacy_user", "Legacy User", "password-hash", "unchanged-encryption-public-key",
		"legacy-encrypted-private-key", "legacy-salt", time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := result.LastInsertId()
	identity := testRegistrationPayload("unused", "Unused", "")
	body, _ := json.Marshal(map[string]any{
		"encrypted_private_key": identity["encrypted_private_key"],
		"crypto_salt":           identity["crypto_salt"],
		"signing_public_key":    identity["signing_public_key"],
		"signing_key_id":        identity["signing_key_id"],
	})
	request := httptest.NewRequest(http.MethodPut, "/api/me/identity", bytes.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), userIDKey, userID))
	response := httptest.NewRecorder()
	handler.UpdateIdentity(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("identity upgrade status=%d body=%s", response.Code, response.Body.String())
	}
	var publicKey, encryptedPrivateKey, cryptoSalt, signingPublicKey, signingKeyID string
	if err := db.QueryRow(`SELECT public_key,encrypted_private_key,crypto_salt,signing_public_key,signing_key_id FROM users WHERE id=?`, userID).
		Scan(&publicKey, &encryptedPrivateKey, &cryptoSalt, &signingPublicKey, &signingKeyID); err != nil {
		t.Fatal(err)
	}
	if publicKey != "unchanged-encryption-public-key" || encryptedPrivateKey != identity["encrypted_private_key"] || cryptoSalt != "argon2id-v2" ||
		signingPublicKey != identity["signing_public_key"] || signingKeyID != identity["signing_key_id"] {
		t.Fatalf("unexpected upgraded identity public=%q signingID=%q", publicKey, signingKeyID)
	}
	var signingKeyCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_signing_keys WHERE user_id=? AND key_id=?`, userID, signingKeyID).Scan(&signingKeyCount); err != nil || signingKeyCount != 1 {
		t.Fatalf("signing key history count=%d err=%v", signingKeyCount, err)
	}
	idempotentRequest := httptest.NewRequest(http.MethodPut, "/api/me/identity", bytes.NewReader(body))
	idempotentRequest = idempotentRequest.WithContext(context.WithValue(idempotentRequest.Context(), userIDKey, userID))
	idempotentResponse := httptest.NewRecorder()
	handler.UpdateIdentity(idempotentResponse, idempotentRequest)
	if idempotentResponse.Code != http.StatusOK {
		t.Fatalf("idempotent identity upgrade status=%d body=%s", idempotentResponse.Code, idempotentResponse.Body.String())
	}
	changedEnvelope := strings.Replace(identity["encrypted_private_key"].(string), `"data":"AAAAAAAA`, `"data":"AQAAAAAA`, 1)
	changedBody, _ := json.Marshal(map[string]any{
		"encrypted_private_key": changedEnvelope,
		"crypto_salt":           identity["crypto_salt"],
		"signing_public_key":    identity["signing_public_key"],
		"signing_key_id":        identity["signing_key_id"],
	})
	changedRequest := httptest.NewRequest(http.MethodPut, "/api/me/identity", bytes.NewReader(changedBody))
	changedRequest = changedRequest.WithContext(context.WithValue(changedRequest.Context(), userIDKey, userID))
	changedResponse := httptest.NewRecorder()
	handler.UpdateIdentity(changedResponse, changedRequest)
	if changedResponse.Code != http.StatusConflict {
		t.Fatalf("identity replacement status=%d body=%s", changedResponse.Code, changedResponse.Body.String())
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

func TestIndividualInvitationBypassesGlobalCodeAndIsSingleUse(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}
	if first := registerRequest(t, handler, "first_admin"); first.Code != http.StatusCreated {
		t.Fatalf("first registration status=%d body=%s", first.Code, first.Body.String())
	}
	if err := settings.SetInvitationCode(db, "global-code-2026"); err != nil {
		t.Fatal(err)
	}
	if err := settings.SetInvitationCodeRequired(db, true); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO invitation_contacts(created_by,first_name,last_name,email,phone,code_hash,expires_at,created_at)
		VALUES(?,?,?,?,?,?,?,?)`, 1, "Invited", "Member", "member@example.com", "", invitationstore.HashCode("team-2026"),
		time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	accepted := registerRequestWithInvitationLink(t, handler, "invited_member", "team-2026")
	if accepted.Code != http.StatusCreated {
		t.Fatalf("individual invitation status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	usedAgain := registerRequestWithInvitationLink(t, handler, "another_member", "team-2026")
	if usedAgain.Code != http.StatusGone {
		t.Fatalf("reused invitation status=%d body=%s", usedAgain.Code, usedAgain.Body.String())
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
	var recoverableUserID int64
	if err := db.QueryRow(`SELECT id FROM users WHERE username='recoverable_user'`).Scan(&recoverableUserID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO trusted_devices(id,user_id,key_id,public_key,device_name,device_type,created_at,last_used_at)
		VALUES(?,?,?,?,?,?,?,?)`, "recovery-test-device", recoverableUserID, testsupport.SigningKeyID, testsupport.SigningPublicKey,
		"Lost device", "browser", time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
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
	var trustedAfterReset int
	if err := db.QueryRow(`SELECT COUNT(*) FROM trusted_devices WHERE user_id=?`, recoverableUserID).Scan(&trustedAfterReset); err != nil || trustedAfterReset != 0 {
		t.Fatalf("password recovery left %d trusted devices: %v", trustedAfterReset, err)
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
	if _, err := db.Exec(`DELETE FROM sessions WHERE user_id=1`); err != nil {
		t.Fatal(err)
	}
	shortLogin := loginRequestWithRemember(t, handler, "session_user", "Password123!", false)
	if shortLogin.Code != http.StatusOK {
		t.Fatalf("short login status=%d body=%s", shortLogin.Code, shortLogin.Body.String())
	}
	shortCookie := shortLogin.Result().Cookies()[0]
	if !shortCookie.Expires.IsZero() {
		t.Fatalf("short session should not set cookie Expires, got %s", shortCookie.Expires)
	}

	if _, err := db.Exec(`DELETE FROM sessions WHERE user_id=1`); err != nil {
		t.Fatal(err)
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

func TestNewDeviceSessionRequiresApprovalAndCanBeRevoked(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	registered := registerRequest(t, handler, "device_session_user")
	if registered.Code != http.StatusCreated {
		t.Fatalf("registration status=%d body=%s", registered.Code, registered.Body.String())
	}
	approvedCookie := registered.Result().Cookies()[0]
	approvedSessionID := approvedCookie.Value

	loginBody, _ := json.Marshal(map[string]any{
		"username": "device_session_user", "password": "Password123!",
		"device_name": "Firefox · MacBook", "device_type": "desktop",
		"device_key_id": testsupport.SigningKeyID, "device_public_key": testsupport.SigningPublicKey,
	})
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody))
	loginRequest.Host = "chat.example.test"
	loginRequest.RemoteAddr = "203.0.113.42:43120"
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("User-Agent", "Vibration session test")
	loginResponse := httptest.NewRecorder()
	handler.Login(loginResponse, loginRequest)
	if loginResponse.Code != http.StatusAccepted {
		t.Fatalf("new device login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
	var approval struct {
		Required  bool   `json:"approval_required"`
		Token     string `json:"approval_token"`
		Code      string `json:"approval_code"`
		QRCode    string `json:"qr_code"`
		ExpiresAt string `json:"approval_expires_at"`
	}
	if err := json.Unmarshal(loginResponse.Body.Bytes(), &approval); err != nil {
		t.Fatal(err)
	}
	if !approval.Required || len(approval.Token) < 32 || len(approval.Code) != 9 || !strings.HasPrefix(approval.QRCode, "data:image/png;base64,") || approval.ExpiresAt == "" {
		t.Fatalf("incomplete approval response: %+v", approval)
	}
	pendingCookie := loginResponse.Result().Cookies()[0]
	pendingSessionID := pendingCookie.Value
	if pendingSessionID == approvedSessionID {
		t.Fatal("new device must receive a distinct session secret")
	}

	var storedTokenHash, storedCodeHash string
	if err := db.QueryRow(`SELECT approval_token_hash,approval_code_hash FROM sessions WHERE id=?`, pendingSessionID).Scan(&storedTokenHash, &storedCodeHash); err != nil {
		t.Fatal(err)
	}
	if storedTokenHash == approval.Token || storedCodeHash == approval.Code || storedTokenHash != sessionApprovalHash(approval.Token) || storedCodeHash != sessionApprovalHash(normalizeApprovalCode(approval.Code)) {
		t.Fatal("approval secrets must only be stored as hashes")
	}

	protectedProbe := handler.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	pendingProbeRequest := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	pendingProbeRequest.AddCookie(pendingCookie)
	pendingProbe := httptest.NewRecorder()
	protectedProbe.ServeHTTP(pendingProbe, pendingProbeRequest)
	if pendingProbe.Code != http.StatusForbidden {
		t.Fatalf("pending session probe status=%d body=%s", pendingProbe.Code, pendingProbe.Body.String())
	}

	sessionsRequest := httptest.NewRequest(http.MethodGet, "/api/me/sessions", nil)
	sessionsRequest.AddCookie(approvedCookie)
	sessionsResponse := httptest.NewRecorder()
	handler.Middleware(http.HandlerFunc(handler.Sessions)).ServeHTTP(sessionsResponse, sessionsRequest)
	if sessionsResponse.Code != http.StatusOK {
		t.Fatalf("session list status=%d body=%s", sessionsResponse.Code, sessionsResponse.Body.String())
	}
	var sessions []DeviceSession
	if err := json.Unmarshal(sessionsResponse.Body.Bytes(), &sessions); err != nil {
		t.Fatal(err)
	}
	if len(sessions) != 2 {
		t.Fatalf("session list length=%d body=%s", len(sessions), sessionsResponse.Body.String())
	}
	var pendingReference string
	for _, session := range sessions {
		if session.ID == approvedSessionID || session.ID == pendingSessionID || len(session.ID) != 24 {
			t.Fatalf("public session reference must not expose bearer secret: %+v", session)
		}
		if session.Pending {
			pendingReference = session.ID
			if session.DeviceName != "Firefox · MacBook" || session.IPAddress != "203.0.113.42" {
				t.Fatalf("unexpected pending device metadata: %+v", session)
			}
		}
	}
	if pendingReference == "" {
		t.Fatal("pending session is absent from the device list")
	}

	approveBody, _ := json.Marshal(map[string]any{"token": approval.Token})
	approveRequest := httptest.NewRequest(http.MethodPost, "/api/me/sessions/approve", bytes.NewReader(approveBody))
	approveRequest.Header.Set("Content-Type", "application/json")
	approveRequest.AddCookie(approvedCookie)
	approveResponse := httptest.NewRecorder()
	handler.Middleware(http.HandlerFunc(handler.ApproveSession)).ServeHTTP(approveResponse, approveRequest)
	if approveResponse.Code != http.StatusOK {
		t.Fatalf("approval status=%d body=%s", approveResponse.Code, approveResponse.Body.String())
	}
	var approvedAt sql.NullString
	var clearedToken, clearedCode sql.NullString
	if err := db.QueryRow(`SELECT approved_at,approval_token_hash,approval_code_hash FROM sessions WHERE id=?`, pendingSessionID).Scan(&approvedAt, &clearedToken, &clearedCode); err != nil {
		t.Fatal(err)
	}
	if !approvedAt.Valid || clearedToken.Valid || clearedCode.Valid {
		t.Fatal("approved session must clear its one-use approval secrets")
	}
	var trustedCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM trusted_devices d JOIN sessions s ON s.trusted_device_id=d.id
		WHERE d.user_id=1 AND d.key_id=? AND s.id=?`, testsupport.SigningKeyID, pendingSessionID).Scan(&trustedCount); err != nil || trustedCount != 1 {
		t.Fatalf("approved device was not enrolled as trusted: count=%d err=%v", trustedCount, err)
	}

	statusRequest := httptest.NewRequest(http.MethodGet, "/api/session/status", nil)
	statusRequest.AddCookie(pendingCookie)
	statusResponse := httptest.NewRecorder()
	handler.PendingSessionStatus(statusResponse, statusRequest)
	if statusResponse.Code != http.StatusOK || !strings.Contains(statusResponse.Body.String(), `"state":"approved"`) {
		t.Fatalf("approved pending status=%d body=%s", statusResponse.Code, statusResponse.Body.String())
	}
	approvedProbeRequest := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	approvedProbeRequest.AddCookie(pendingCookie)
	approvedProbe := httptest.NewRecorder()
	protectedProbe.ServeHTTP(approvedProbe, approvedProbeRequest)
	if approvedProbe.Code != http.StatusNoContent {
		t.Fatalf("approved session probe status=%d body=%s", approvedProbe.Code, approvedProbe.Body.String())
	}

	reuseRequest := httptest.NewRequest(http.MethodPost, "/api/me/sessions/approve", bytes.NewReader(approveBody))
	reuseRequest.Header.Set("Content-Type", "application/json")
	reuseRequest.AddCookie(approvedCookie)
	reuseResponse := httptest.NewRecorder()
	handler.Middleware(http.HandlerFunc(handler.ApproveSession)).ServeHTTP(reuseResponse, reuseRequest)
	if reuseResponse.Code != http.StatusNotFound {
		t.Fatalf("reused approval token status=%d body=%s", reuseResponse.Code, reuseResponse.Body.String())
	}

	revokeRequest := httptest.NewRequest(http.MethodDelete, "/api/me/sessions/"+pendingReference, nil)
	revokeRequest.SetPathValue("id", pendingReference)
	revokeRequest.AddCookie(approvedCookie)
	revokeResponse := httptest.NewRecorder()
	handler.Middleware(http.HandlerFunc(handler.RevokeSession)).ServeHTTP(revokeResponse, revokeRequest)
	if revokeResponse.Code != http.StatusOK {
		t.Fatalf("revoke status=%d body=%s", revokeResponse.Code, revokeResponse.Body.String())
	}
	revokedProbeRequest := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
	revokedProbeRequest.AddCookie(pendingCookie)
	revokedProbe := httptest.NewRecorder()
	protectedProbe.ServeHTTP(revokedProbe, revokedProbeRequest)
	if revokedProbe.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session probe status=%d body=%s", revokedProbe.Code, revokedProbe.Body.String())
	}

	expiringLoginRequest := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody))
	expiringLoginRequest.Host = "chat.example.test"
	expiringLoginRequest.RemoteAddr = "203.0.113.43:43121"
	expiringLoginRequest.Header.Set("Content-Type", "application/json")
	expiringLoginResponse := httptest.NewRecorder()
	handler.Login(expiringLoginResponse, expiringLoginRequest)
	if expiringLoginResponse.Code != http.StatusAccepted {
		t.Fatalf("expiring login status=%d body=%s", expiringLoginResponse.Code, expiringLoginResponse.Body.String())
	}
	expiringCookie := expiringLoginResponse.Result().Cookies()[0]
	if _, err := db.Exec(`UPDATE sessions SET approval_expires_at=? WHERE id=?`, time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano), expiringCookie.Value); err != nil {
		t.Fatal(err)
	}
	expiredStatusRequest := httptest.NewRequest(http.MethodGet, "/api/session/status", nil)
	expiredStatusRequest.AddCookie(expiringCookie)
	expiredStatusResponse := httptest.NewRecorder()
	handler.PendingSessionStatus(expiredStatusResponse, expiredStatusRequest)
	if expiredStatusResponse.Code != http.StatusOK || !strings.Contains(expiredStatusResponse.Body.String(), `"state":"expired"`) {
		t.Fatalf("expired pending status=%d body=%s", expiredStatusResponse.Code, expiredStatusResponse.Body.String())
	}
	var expiredSessionCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE id=?`, expiringCookie.Value).Scan(&expiredSessionCount); err != nil || expiredSessionCount != 0 {
		t.Fatalf("expired pending session count=%d err=%v", expiredSessionCount, err)
	}
}

func TestTrustedDeviceProvesItselfAfterItsPreviousSessionExpires(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	handler := &Handler{DB: db}

	payload := testRegistrationPayload("trusted_device_user", "Trusted Device User", "")
	payload["device_key_id"] = testsupport.SigningKeyID
	payload["device_public_key"] = testsupport.SigningPublicKey
	payload["device_name"] = "Safari · MacBook"
	payload["device_type"] = "browser"
	body, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:12345"
	registered := httptest.NewRecorder()
	handler.Register(registered, request)
	if registered.Code != http.StatusCreated {
		t.Fatalf("registration status=%d body=%s", registered.Code, registered.Body.String())
	}
	firstCookie := registered.Result().Cookies()[0]
	var userID int64
	if err := db.QueryRow(`SELECT id FROM users WHERE username='trusted_device_user'`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	var deviceID string
	if err := db.QueryRow(`SELECT id FROM trusted_devices WHERE user_id=? AND key_id=?`, userID, testsupport.SigningKeyID).Scan(&deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DELETE FROM sessions WHERE id=?`, firstCookie.Value); err != nil {
		t.Fatal(err)
	}

	loginBody, _ := json.Marshal(map[string]any{
		"username": "trusted_device_user", "password": "Password123!",
		"device_key_id": testsupport.SigningKeyID, "device_public_key": testsupport.SigningPublicKey,
		"device_name": "Safari · MacBook", "device_type": "browser",
	})
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/login", bytes.NewReader(loginBody))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Host = "chat.example.test"
	loginRequest.RemoteAddr = "127.0.0.1:23456"
	loginResponse := httptest.NewRecorder()
	handler.Login(loginResponse, loginRequest)
	if loginResponse.Code != http.StatusAccepted {
		t.Fatalf("trusted login status=%d body=%s", loginResponse.Code, loginResponse.Body.String())
	}
	var pending struct {
		ApprovalRequired    bool   `json:"approval_required"`
		DeviceProofRequired bool   `json:"device_proof_required"`
		Challenge           string `json:"device_challenge"`
	}
	if err := json.Unmarshal(loginResponse.Body.Bytes(), &pending); err != nil {
		t.Fatal(err)
	}
	if !pending.ApprovalRequired || !pending.DeviceProofRequired || len(pending.Challenge) < 32 {
		t.Fatalf("missing trusted-device challenge: %+v", pending)
	}
	pendingCookie := loginResponse.Result().Cookies()[0]
	invalidProofBody, _ := json.Marshal(map[string]any{
		"device_key_id": testsupport.SigningKeyID,
		"challenge":     pending.Challenge,
		"signature":     signTrustedDeviceTestChallenge(t, pending.Challenge+"-tampered"),
	})
	invalidProofRequest := httptest.NewRequest(http.MethodPost, "/api/session/device-proof", bytes.NewReader(invalidProofBody))
	invalidProofRequest.Header.Set("Content-Type", "application/json")
	invalidProofRequest.AddCookie(pendingCookie)
	invalidProofRequest.RemoteAddr = "127.0.0.1:23456"
	invalidProofResponse := httptest.NewRecorder()
	handler.ProveTrustedDevice(invalidProofResponse, invalidProofRequest)
	if invalidProofResponse.Code != http.StatusUnauthorized {
		t.Fatalf("invalid trusted proof status=%d body=%s", invalidProofResponse.Code, invalidProofResponse.Body.String())
	}
	proofBody, _ := json.Marshal(map[string]any{
		"device_key_id": testsupport.SigningKeyID,
		"challenge":     pending.Challenge,
		"signature":     signTrustedDeviceTestChallenge(t, pending.Challenge),
	})
	proofRequest := httptest.NewRequest(http.MethodPost, "/api/session/device-proof", bytes.NewReader(proofBody))
	proofRequest.Header.Set("Content-Type", "application/json")
	proofRequest.AddCookie(pendingCookie)
	proofRequest.RemoteAddr = "127.0.0.1:23456"
	proofResponse := httptest.NewRecorder()
	handler.ProveTrustedDevice(proofResponse, proofRequest)
	if proofResponse.Code != http.StatusOK {
		t.Fatalf("trusted proof status=%d body=%s", proofResponse.Code, proofResponse.Body.String())
	}
	reusedProofRequest := httptest.NewRequest(http.MethodPost, "/api/session/device-proof", bytes.NewReader(proofBody))
	reusedProofRequest.Header.Set("Content-Type", "application/json")
	reusedProofRequest.AddCookie(pendingCookie)
	reusedProofRequest.RemoteAddr = "127.0.0.1:23456"
	reusedProofResponse := httptest.NewRecorder()
	handler.ProveTrustedDevice(reusedProofResponse, reusedProofRequest)
	if reusedProofResponse.Code != http.StatusUnauthorized {
		t.Fatalf("reused trusted proof status=%d body=%s", reusedProofResponse.Code, reusedProofResponse.Body.String())
	}

	devicesRequest := httptest.NewRequest(http.MethodGet, "/api/me/trusted-devices", nil)
	devicesRequest.AddCookie(pendingCookie)
	devicesResponse := httptest.NewRecorder()
	handler.Middleware(http.HandlerFunc(handler.TrustedDevices)).ServeHTTP(devicesResponse, devicesRequest)
	if devicesResponse.Code != http.StatusOK || !strings.Contains(devicesResponse.Body.String(), `"current":true`) {
		t.Fatalf("trusted device list status=%d body=%s", devicesResponse.Code, devicesResponse.Body.String())
	}

	revokeRequest := httptest.NewRequest(http.MethodDelete, "/api/me/trusted-devices/"+deviceID, nil)
	revokeRequest.SetPathValue("id", deviceID)
	revokeRequest.AddCookie(pendingCookie)
	revokeResponse := httptest.NewRecorder()
	handler.Middleware(http.HandlerFunc(handler.RevokeTrustedDevice)).ServeHTTP(revokeResponse, revokeRequest)
	if revokeResponse.Code != http.StatusOK || !strings.Contains(revokeResponse.Body.String(), `"current":true`) {
		t.Fatalf("trusted device revoke status=%d body=%s", revokeResponse.Code, revokeResponse.Body.String())
	}
	var devices, sessions int
	_ = db.QueryRow(`SELECT COUNT(*) FROM trusted_devices WHERE user_id=?`, userID).Scan(&devices)
	_ = db.QueryRow(`SELECT COUNT(*) FROM sessions WHERE user_id=?`, userID).Scan(&sessions)
	if devices != 0 || sessions != 0 {
		t.Fatalf("revocation left devices=%d sessions=%d", devices, sessions)
	}
}

func registerRequest(t *testing.T, handler *Handler, username string) *httptest.ResponseRecorder {
	return registerRequestWithInvitation(t, handler, username, "")
}

func registerRequestWithInvitation(t *testing.T, handler *Handler, username, invitationCode string) *httptest.ResponseRecorder {
	return registerRequestWithDisplayName(t, handler, username, username, invitationCode)
}

func registerRequestWithInvitationLink(t *testing.T, handler *Handler, username, invitationCode string) *httptest.ResponseRecorder {
	t.Helper()
	payload := testRegistrationPayload(username, username, invitationCode)
	payload["invitation_link"] = true
	body, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.Register(response, request)
	return response
}

func registerRequestWithDisplayName(t *testing.T, handler *Handler, username, displayName, invitationCode string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(testRegistrationPayload(username, displayName, invitationCode))
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(body))
	request.RemoteAddr = "127.0.0.1:12345"
	response := httptest.NewRecorder()
	handler.Register(response, request)
	return response
}

func testRegistrationPayload(username, displayName, invitationCode string) map[string]any {
	return map[string]any{
		"username": username, "display_name": displayName, "password": "Password123!", "invitation_code": invitationCode,
		"public_key":            "public-key-placeholder-value",
		"encrypted_private_key": `{"v":2,"kdf":{"name":"argon2id","version":19,"memory_kib":32768,"iterations":3,"parallelism":1,"hash_length":32,"salt":"AAAAAAAAAAAAAAAAAAAAAA=="},"cipher":{"name":"AES-GCM","iv":"AAAAAAAAAAAAAAAA"},"data":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`,
		"crypto_salt":           "argon2id-v2",
		"signing_public_key":    `{"kty":"EC","crv":"P-256","x":"P1xgrChMoYjH2ksx1_ths9hjWlAUzXvm1iGGKf9wi34","y":"tijzBhBWCeQyQZADxQdzy0iJzba2WLy16qh0vHHsFRw"}`,
		"signing_key_id":        "123a50372c29870ea73e4f730448f1d936620091eae3642c6f54b5b0377bbaa6",
	}
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
