package auth

import (
	"crypto/rand"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"regexp"
	"strings"
	"time"

	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/invitationstore"
	"chat-pwa-go/internal/messageauth"
	"chat-pwa-go/internal/settings"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
	"modernc.org/sqlite"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

const (
	sqliteConstraintPrimaryKey = 1555
	sqliteConstraintUnique     = 2067
)

type Handler struct {
	DB                    *sql.DB
	Hub                   SessionHub
	SecureCookies         bool
	CookieSameSite        http.SameSite
	DisableRegistration   bool
	DisableInvitationCode bool
	AuthLimiter           *RateLimiter
}

type authRequest struct {
	Username            string `json:"username"`
	DisplayName         string `json:"display_name"`
	Password            string `json:"password"`
	PublicKey           string `json:"public_key"`
	EncryptedPrivateKey string `json:"encrypted_private_key"`
	CryptoSalt          string `json:"crypto_salt"`
	SigningPublicKey    string `json:"signing_public_key"`
	SigningKeyID        string `json:"signing_key_id"`
	InvitationCode      string `json:"invitation_code"`
	InvitationLink      bool   `json:"invitation_link"`
	RecoveryCode        string `json:"recovery_code"`
	NewPassword         string `json:"new_password"`
	RememberMe          bool   `json:"remember_me"`
	DesktopClient       bool   `json:"desktop_client"`
	DeviceName          string `json:"device_name"`
	DeviceType          string `json:"device_type"`
	DeviceKeyID         string `json:"device_key_id"`
	DevicePublicKey     string `json:"device_public_key"`
}

type User struct {
	ID                  int64   `json:"id"`
	Username            string  `json:"username"`
	DisplayName         string  `json:"display_name"`
	Description         string  `json:"description"`
	PublicKey           string  `json:"public_key"`
	EncryptedPrivateKey string  `json:"encrypted_private_key,omitempty"`
	CryptoSalt          string  `json:"crypto_salt,omitempty"`
	SigningPublicKey    string  `json:"signing_public_key,omitempty"`
	SigningKeyID        string  `json:"signing_key_id,omitempty"`
	Avatar              *string `json:"avatar"`
	IsDiscoverable      bool    `json:"is_discoverable"`
	HasDiscoveryCode    bool    `json:"has_discovery_code"`
	IsAdmin             bool    `json:"is_admin"`
	IsManager           bool    `json:"is_manager"`
	IsBanned            bool    `json:"is_banned"`
	CreatedAt           string  `json:"created_at"`
}

type registerResponse struct {
	User
	RecoveryCode string `json:"recovery_code"`
	SessionToken string `json:"session_token,omitempty"`
}

func (h *Handler) RegistrationSettings(w http.ResponseWriter, _ *http.Request) {
	if h.DisableInvitationCode {
		httpx.JSON(w, http.StatusOK, map[string]bool{"invitation_code_required": false})
		return
	}
	var existingUsers int
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&existingUsers); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "settings lookup failed")
		return
	}
	if existingUsers == 0 {
		httpx.JSON(w, http.StatusOK, map[string]bool{"invitation_code_required": false})
		return
	}
	required, err := settings.InvitationCodeRequired(h.DB)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "settings lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"invitation_code_required": required})
}

func (h *Handler) Register(w http.ResponseWriter, r *http.Request) {
	var input authRequest
	if !httpx.Decode(w, r, &input) {
		return
	}
	input.Username = strings.ToLower(strings.TrimSpace(input.Username))
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if !usernamePattern.MatchString(input.Username) || len(input.DisplayName) < 1 || len(input.DisplayName) > 80 ||
		len(input.Password) < 8 || len(input.Password) > 256 || len(input.PublicKey) < 20 ||
		len(input.EncryptedPrivateKey) < 20 || input.CryptoSalt != "argon2id-v2" || !validV2IdentityEnvelope(input.EncryptedPrivateKey) {
		httpx.Error(w, http.StatusBadRequest, "invalid registration fields")
		return
	}
	canonicalSigningKey, signingKeyID, _, err := messageauth.CanonicalPublicKey(input.SigningPublicKey)
	if err != nil || signingKeyID != input.SigningKeyID {
		httpx.Error(w, http.StatusBadRequest, "invalid registration identity")
		return
	}
	input.SigningPublicKey = canonicalSigningKey
	deviceKeyID, devicePublicKey, err := canonicalTrustedDeviceCredential(input.DeviceKeyID, input.DevicePublicKey)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid trusted device credential")
		return
	}
	input.DeviceKeyID, input.DevicePublicKey = deviceKeyID, devicePublicKey
	if !h.allowAuthAttempt(w, r, "register", input.Username) {
		return
	}
	var existingUsers int
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&existingUsers); err != nil {
		log.Printf("registration failed: count users: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "registration failed")
		return
	}
	if h.DisableRegistration {
		if existingUsers > 0 {
			httpx.Error(w, http.StatusForbidden, "registration disabled")
			return
		}
	}
	invitationID, invitationValid, err := invitationstore.ActiveID(h.DB, input.InvitationCode, time.Now().UTC())
	if err != nil {
		log.Printf("registration failed: individual invitation lookup: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "registration failed")
		return
	}
	if input.InvitationLink && !invitationValid {
		httpx.Error(w, http.StatusGone, "invitation unavailable")
		return
	}
	if existingUsers > 0 && !h.DisableInvitationCode {
		required, err := settings.InvitationCodeRequired(h.DB)
		if err != nil {
			log.Printf("registration failed: invitation setting: %v", err)
			httpx.Error(w, http.StatusInternalServerError, "registration failed")
			return
		}
		if required && !invitationValid {
			valid, err := settings.VerifyInvitationCode(h.DB, input.InvitationCode)
			if err != nil {
				log.Printf("registration failed: invitation verification: %v", err)
				httpx.Error(w, http.StatusInternalServerError, "registration failed")
				return
			}
			if !valid {
				httpx.Error(w, http.StatusForbidden, "invalid invitation code")
				return
			}
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), 12)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "password hashing failed")
		return
	}
	recoveryCode, recoveryHash, err := newRecoveryCode()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "recovery code creation failed")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := h.DB.Begin()
	if err != nil {
		log.Printf("registration failed: begin transaction: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "registration failed")
		return
	}
	defer tx.Rollback()
	var userCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&userCount); err != nil {
		log.Printf("registration failed: count users in transaction: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "registration failed")
		return
	}
	var usernameCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users WHERE username=?`, input.Username).Scan(&usernameCount); err != nil {
		log.Printf("registration failed: check username: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "registration failed")
		return
	}
	if usernameCount > 0 {
		httpx.Error(w, http.StatusConflict, "username already exists")
		return
	}
	var displayNameCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users WHERE lower(display_name)=lower(?)`, input.DisplayName).Scan(&displayNameCount); err != nil {
		log.Printf("registration failed: check display name: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "registration failed")
		return
	}
	if displayNameCount > 0 {
		httpx.Error(w, http.StatusConflict, "display name already exists")
		return
	}
	isAdmin := userCount == 0
	result, err := tx.Exec(`INSERT INTO users(username,display_name,description,password_hash,recovery_code_hash,public_key,encrypted_private_key,crypto_salt,signing_public_key,signing_key_id,is_admin,created_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, input.Username, input.DisplayName, "", string(hash), recoveryHash, input.PublicKey, input.EncryptedPrivateKey, input.CryptoSalt,
		input.SigningPublicKey, input.SigningKeyID, isAdmin, now)
	if err != nil {
		log.Printf("registration failed: insert user: %v", err)
		status, message := registrationInsertError(err)
		httpx.Error(w, status, message)
		return
	}
	id, _ := result.LastInsertId()
	if _, err := tx.Exec(`INSERT INTO user_signing_keys(user_id,key_id,public_key,created_at) VALUES(?,?,?,?)`, id, input.SigningKeyID, input.SigningPublicKey, now); err != nil {
		log.Printf("registration failed: insert signing key: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "registration failed")
		return
	}
	if invitationID != 0 {
		consumed, err := invitationstore.Consume(tx, invitationID, id, time.Now().UTC())
		if err != nil {
			log.Printf("registration failed: consume invitation: %v", err)
			httpx.Error(w, http.StatusInternalServerError, "registration failed")
			return
		}
		if !consumed {
			httpx.Error(w, http.StatusGone, "invitation unavailable")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		log.Printf("registration failed: commit: %v", err)
		httpx.Error(w, http.StatusInternalServerError, "registration failed")
		return
	}
	session, err := h.createSession(w, r, id, true, input, sessionTrust{})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session creation failed")
		return
	}
	if err := h.enrollSessionCredential(id, session.Token, input); err != nil {
		_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=?`, session.Token)
		httpx.Error(w, http.StatusInternalServerError, "trusted device enrollment failed")
		return
	}
	response := registerResponse{
		User: User{ID: id, Username: input.Username, DisplayName: input.DisplayName, PublicKey: input.PublicKey,
			SigningPublicKey: input.SigningPublicKey, SigningKeyID: input.SigningKeyID, IsDiscoverable: true, IsAdmin: isAdmin, CreatedAt: now},
		RecoveryCode: recoveryCode,
	}
	if input.DesktopClient {
		response.SessionToken = session.Token
	}
	httpx.JSON(w, http.StatusCreated, response)
}

func registrationInsertError(err error) (int, string) {
	if isUniqueConstraintOn(err, "users", "username", "users_username_key", "username") {
		return http.StatusConflict, "username already exists"
	}
	if isUniqueConstraintOn(err, "users", "display_name", "users_display_name_key", "display_name") {
		return http.StatusConflict, "display name already exists"
	}
	return http.StatusInternalServerError, "registration failed"
}

func isUniqueConstraintOn(err error, table, column string, constraintNames ...string) bool {
	errText := strings.ToLower(err.Error())

	var sqliteErr *sqlite.Error
	if errors.As(err, &sqliteErr) {
		if sqliteErr.Code() != sqliteConstraintUnique && sqliteErr.Code() != sqliteConstraintPrimaryKey {
			return false
		}
		return strings.Contains(errText, table+"."+column)
	}

	var mysqlErr *mysql.MySQLError
	if errors.As(err, &mysqlErr) {
		if mysqlErr.Number != 1062 {
			return false
		}
		for _, name := range constraintNames {
			if strings.Contains(errText, strings.ToLower(name)) {
				return true
			}
		}
		return false
	}

	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if pgErr.Code != "23505" {
			return false
		}
		for _, name := range constraintNames {
			if strings.EqualFold(pgErr.ConstraintName, name) {
				return true
			}
		}
		return strings.EqualFold(pgErr.TableName, table) && strings.EqualFold(pgErr.ColumnName, column)
	}

	return false
}

func (h *Handler) Login(w http.ResponseWriter, r *http.Request) {
	var input authRequest
	if !httpx.Decode(w, r, &input) {
		return
	}
	input.Username = strings.ToLower(strings.TrimSpace(input.Username))
	if !h.allowAuthAttempt(w, r, "login", input.Username) {
		return
	}
	var id int64
	var hash string
	var banned bool
	if err := h.DB.QueryRow(`SELECT id,password_hash,is_banned FROM users WHERE username=?`, input.Username).Scan(&id, &hash, &banned); err != nil ||
		bcrypt.CompareHashAndPassword([]byte(hash), []byte(input.Password)) != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid username or password")
		return
	}
	if banned {
		httpx.Error(w, http.StatusForbidden, "account banned")
		return
	}
	deviceKeyID, devicePublicKey, err := canonicalTrustedDeviceCredential(input.DeviceKeyID, input.DevicePublicKey)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid trusted device credential")
		return
	}
	input.DeviceKeyID, input.DevicePublicKey = deviceKeyID, devicePublicKey
	trustedDeviceID, knownTrustedDevice, err := h.trustedDeviceForKey(id, deviceKeyID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device lookup failed")
		return
	}
	hasTrustedDevice, err := h.hasTrustedDevices(id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session lookup failed")
		return
	}
	requiresApproval := hasTrustedDevice
	if !hasTrustedDevice {
		requiresApproval, err = h.requiresSessionApproval(id)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "session lookup failed")
			return
		}
	}
	trust := sessionTrust{ApprovalRequired: requiresApproval, TrustedDeviceID: trustedDeviceID, ProofRequired: knownTrustedDevice}
	session, err := h.createSession(w, r, id, input.RememberMe, input, trust)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session creation failed")
		return
	}
	if !requiresApproval {
		if err := h.enrollSessionCredential(id, session.Token, input); err != nil {
			_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=?`, session.Token)
			httpx.Error(w, http.StatusInternalServerError, "trusted device enrollment failed")
			return
		}
	}
	response := map[string]any{"ok": !requiresApproval, "approval_required": requiresApproval}
	if input.DesktopClient {
		response["session_token"] = session.Token
	}
	status := http.StatusOK
	if requiresApproval {
		status = http.StatusAccepted
		response["approval_code"] = session.ApprovalCode
		response["approval_token"] = session.ApprovalToken
		response["approval_expires_at"] = session.ApprovalExpiresAt
		response["qr_code"] = session.QRCode
		if session.DeviceChallenge != "" {
			response["device_proof_required"] = true
			response["device_challenge"] = session.DeviceChallenge
		}
		if h.Hub != nil && session.DeviceChallenge == "" {
			h.Hub.SendToUser(id, map[string]any{"type": "session_approval_requested"})
		}
	}
	httpx.JSON(w, status, response)
}

func (h *Handler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	var input authRequest
	if !httpx.Decode(w, r, &input) {
		return
	}
	input.Username = strings.ToLower(strings.TrimSpace(input.Username))
	recoveryCode := normalizeRecoveryCode(input.RecoveryCode)
	if !usernamePattern.MatchString(input.Username) || recoveryCode == "" || len(input.NewPassword) < 8 || len(input.NewPassword) > 256 {
		httpx.Error(w, http.StatusBadRequest, "invalid password reset request")
		return
	}
	if !h.allowAuthAttempt(w, r, "password-reset", input.Username) {
		return
	}
	var id int64
	var recoveryHash sql.NullString
	var banned bool
	if err := h.DB.QueryRow(`SELECT id,recovery_code_hash,is_banned FROM users WHERE username=?`, input.Username).Scan(&id, &recoveryHash, &banned); err != nil ||
		!recoveryHash.Valid || bcrypt.CompareHashAndPassword([]byte(recoveryHash.String), []byte(recoveryCode)) != nil {
		httpx.Error(w, http.StatusUnauthorized, "invalid recovery code")
		return
	}
	if banned {
		httpx.Error(w, http.StatusForbidden, "account banned")
		return
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(input.NewPassword), 12)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "password hashing failed")
		return
	}
	replacementCode, replacementHash, err := newRecoveryCode()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "recovery code creation failed")
		return
	}
	if _, err := h.DB.Exec(`UPDATE users SET password_hash=?,recovery_code_hash=? WHERE id=?`, string(newHash), replacementHash, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "password reset failed")
		return
	}
	if _, err := h.DB.Exec(`DELETE FROM sessions WHERE user_id=?`, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "session revocation failed")
		return
	}
	if _, err := h.DB.Exec(`DELETE FROM trusted_devices WHERE user_id=?`, id); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "trusted device revocation failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "recovery_code": replacementCode})
}

func (h *Handler) RecoveryCode(w http.ResponseWriter, r *http.Request) {
	var input authRequest
	if !httpx.Decode(w, r, &input) {
		return
	}
	userID := UserID(r)
	var currentHash string
	if err := h.DB.QueryRow(`SELECT password_hash FROM users WHERE id=?`, userID).Scan(&currentHash); err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(input.Password)) != nil {
		httpx.Error(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}
	recoveryCode, recoveryHash, err := newRecoveryCode()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "recovery code creation failed")
		return
	}
	if _, err := h.DB.Exec(`UPDATE users SET recovery_code_hash=? WHERE id=?`, recoveryHash, userID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "recovery code update failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"recovery_code": recoveryCode})
}

func (h *Handler) allowAuthAttempt(w http.ResponseWriter, r *http.Request, action, username string) bool {
	address := clientAddress(r)
	ipKey := action + ":ip:" + address
	userKey := action + ":user:" + address + ":" + username
	if h.AuthLimiter != nil && (!h.AuthLimiter.Allow(ipKey) || !h.AuthLimiter.Allow(userKey)) {
		httpx.Error(w, http.StatusTooManyRequests, "too many authentication attempts")
		return false
	}
	return true
}

func newRecoveryCode() (string, string, error) {
	raw := make([]byte, 10)
	if _, err := rand.Read(raw); err != nil {
		return "", "", err
	}
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	code := encoded[:4] + "-" + encoded[4:8] + "-" + encoded[8:12] + "-" + encoded[12:]
	hash, err := bcrypt.GenerateFromPassword([]byte(normalizeRecoveryCode(code)), 12)
	if err != nil {
		return "", "", err
	}
	return code, string(hash), nil
}

func normalizeRecoveryCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "-", "")
	value = strings.ReplaceAll(value, " ", "")
	return value
}

func clientAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return r.RemoteAddr
}

func (h *Handler) Logout(w http.ResponseWriter, r *http.Request) {
	h.deleteSession(w, r)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	var user User
	var discoveryCodeHash sql.NullString
	err := h.DB.QueryRow(`SELECT id,username,display_name,description,public_key,encrypted_private_key,crypto_salt,signing_public_key,signing_key_id,avatar,
		is_discoverable,discovery_code_hash,is_admin,is_manager,is_banned,created_at FROM users WHERE id=?`, UserID(r)).
		Scan(&user.ID, &user.Username, &user.DisplayName, &user.Description, &user.PublicKey, &user.EncryptedPrivateKey, &user.CryptoSalt,
			&user.SigningPublicKey, &user.SigningKeyID, &user.Avatar, &user.IsDiscoverable, &discoveryCodeHash,
			&user.IsAdmin, &user.IsManager, &user.IsBanned, &user.CreatedAt)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	user.HasDiscoveryCode = discoveryCodeHash.Valid && discoveryCodeHash.String != ""
	httpx.JSON(w, http.StatusOK, user)
}

func (h *Handler) UpdateIdentity(w http.ResponseWriter, r *http.Request) {
	var input struct {
		EncryptedPrivateKey string `json:"encrypted_private_key"`
		CryptoSalt          string `json:"crypto_salt"`
		SigningPublicKey    string `json:"signing_public_key"`
		SigningKeyID        string `json:"signing_key_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	canonical, keyID, _, err := messageauth.CanonicalPublicKey(input.SigningPublicKey)
	if err != nil || keyID != input.SigningKeyID || !validV2IdentityEnvelope(input.EncryptedPrivateKey) || input.CryptoSalt != "argon2id-v2" {
		httpx.Error(w, http.StatusBadRequest, "invalid identity upgrade")
		return
	}
	userID := UserID(r)
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "identity upgrade failed")
		return
	}
	defer tx.Rollback()
	var currentKeyID, currentSigningPublicKey, currentEncryptedPrivateKey, currentCryptoSalt string
	if err := tx.QueryRow(`SELECT signing_key_id,signing_public_key,encrypted_private_key,crypto_salt FROM users WHERE id=?`, userID).
		Scan(&currentKeyID, &currentSigningPublicKey, &currentEncryptedPrivateKey, &currentCryptoSalt); err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	if currentKeyID != "" {
		if currentKeyID == keyID && currentSigningPublicKey == canonical && currentEncryptedPrivateKey == input.EncryptedPrivateKey && currentCryptoSalt == input.CryptoSalt {
			httpx.JSON(w, http.StatusOK, map[string]string{
				"encrypted_private_key": currentEncryptedPrivateKey, "crypto_salt": currentCryptoSalt,
				"signing_public_key": currentSigningPublicKey, "signing_key_id": currentKeyID,
			})
			return
		}
		httpx.Error(w, http.StatusConflict, "signing identity already exists")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := tx.Exec(`UPDATE users SET encrypted_private_key=?,crypto_salt=?,signing_public_key=?,signing_key_id=? WHERE id=?`,
		input.EncryptedPrivateKey, input.CryptoSalt, canonical, keyID, userID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "identity upgrade failed")
		return
	}
	var existing int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM user_signing_keys WHERE user_id=? AND key_id=?`, userID, keyID).Scan(&existing); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "identity upgrade failed")
		return
	}
	if existing == 0 {
		if _, err := tx.Exec(`INSERT INTO user_signing_keys(user_id,key_id,public_key,created_at) VALUES(?,?,?,?)`, userID, keyID, canonical, now); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "identity upgrade failed")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "identity upgrade failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{
		"encrypted_private_key": input.EncryptedPrivateKey, "crypto_salt": input.CryptoSalt,
		"signing_public_key": canonical, "signing_key_id": keyID,
	})
}

func validV2IdentityEnvelope(raw string) bool {
	var envelope struct {
		Version int `json:"v"`
		KDF     struct {
			Name        string `json:"name"`
			Version     int    `json:"version"`
			MemoryKiB   int    `json:"memory_kib"`
			Iterations  int    `json:"iterations"`
			Parallelism int    `json:"parallelism"`
			HashLength  int    `json:"hash_length"`
			Salt        string `json:"salt"`
		} `json:"kdf"`
		Cipher struct {
			Name string `json:"name"`
			IV   string `json:"iv"`
		} `json:"cipher"`
		Data string `json:"data"`
	}
	if len(raw) > 1<<20 || json.Unmarshal([]byte(raw), &envelope) != nil {
		return false
	}
	salt, saltErr := base64.StdEncoding.DecodeString(envelope.KDF.Salt)
	iv, ivErr := base64.StdEncoding.DecodeString(envelope.Cipher.IV)
	data, dataErr := base64.StdEncoding.DecodeString(envelope.Data)
	return envelope.Version == 2 && envelope.KDF.Name == "argon2id" && envelope.KDF.Version == 19 &&
		envelope.KDF.MemoryKiB >= 8192 && envelope.KDF.MemoryKiB <= 262144 && envelope.KDF.Iterations >= 1 && envelope.KDF.Iterations <= 10 &&
		envelope.KDF.Parallelism >= 1 && envelope.KDF.Parallelism <= 4 && envelope.KDF.HashLength == 32 && saltErr == nil && len(salt) == 16 &&
		envelope.Cipher.Name == "AES-GCM" && ivErr == nil && len(iv) == 12 && dataErr == nil && len(data) >= 24
}
