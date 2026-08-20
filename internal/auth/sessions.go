package auth

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"

	"chat-pwa-go/internal/adminaccess"
	"chat-pwa-go/internal/httpx"
)

type contextKey string

const userIDKey contextKey = "user_id"
const usernameKey contextKey = "username"
const adminKey contextKey = "is_admin"
const managerKey contextKey = "is_manager"
const sessionIDKey contextKey = "session_id"
const sessionCookie = "chat_session"
const websocketSessionProtocolPrefix = "vibration-auth."
const shortSessionDuration = 12 * time.Hour
const longSessionDuration = 30 * 24 * time.Hour

type SessionHub interface {
	SendToUser(userID int64, event any) bool
	KickUser(userID int64, event any)
}

type sessionCreation struct {
	Token             string
	ApprovalToken     string
	ApprovalCode      string
	ApprovalExpiresAt string
	QRCode            string
	DeviceChallenge   string
}

type sessionTrust struct {
	ApprovalRequired bool
	TrustedDeviceID  string
	ProofRequired    bool
}

func UserID(r *http.Request) int64 {
	value, _ := r.Context().Value(userIDKey).(int64)
	return value
}

func Username(r *http.Request) string {
	value, _ := r.Context().Value(usernameKey).(string)
	return value
}

func IsAdmin(r *http.Request) bool {
	value, _ := r.Context().Value(adminKey).(bool)
	return value
}

func IsManager(r *http.Request) bool {
	value, _ := r.Context().Value(managerKey).(bool)
	return value
}

func SessionID(r *http.Request) string {
	value, _ := r.Context().Value(sessionIDKey).(string)
	return value
}

func (h *Handler) createSession(w http.ResponseWriter, r *http.Request, userID int64, persistent bool, input authRequest, trust sessionTrust) (sessionCreation, error) {
	id, err := randomSessionToken(32)
	if err != nil {
		return sessionCreation{}, err
	}
	now := time.Now().UTC()
	duration := shortSessionDuration
	if persistent {
		duration = longSessionDuration
	}
	expires := now.Add(duration)
	createdAt := now.Format(time.RFC3339Nano)
	deviceName, deviceType := sessionDeviceMetadata(input.DeviceName, input.DeviceType, r.UserAgent())
	creation := sessionCreation{Token: id}
	var approvedAt, approvalTokenHash, approvalCodeHash, approvalExpiresAt, trustedDeviceID any
	var deviceChallengeHash, deviceChallengeExpiresAt any
	if trust.TrustedDeviceID != "" {
		trustedDeviceID = trust.TrustedDeviceID
	}
	if trust.ApprovalRequired {
		creation.ApprovalToken, err = randomSessionToken(32)
		if err != nil {
			return sessionCreation{}, err
		}
		creation.ApprovalCode, err = randomApprovalCode()
		if err != nil {
			return sessionCreation{}, err
		}
		creation.ApprovalExpiresAt = now.Add(sessionApprovalDuration).Format(time.RFC3339Nano)
		approvalTokenHash = sessionApprovalHash(creation.ApprovalToken)
		approvalCodeHash = sessionApprovalHash(normalizeApprovalCode(creation.ApprovalCode))
		approvalExpiresAt = creation.ApprovalExpiresAt
		creation.QRCode, err = sessionApprovalQRCode(sessionApprovalURL(h, r, creation.ApprovalToken))
		if err != nil {
			return sessionCreation{}, err
		}
		if trust.ProofRequired {
			creation.DeviceChallenge, err = randomSessionToken(32)
			if err != nil {
				return sessionCreation{}, err
			}
			deviceChallengeHash = sessionApprovalHash(creation.DeviceChallenge)
			deviceChallengeExpiresAt = creation.ApprovalExpiresAt
		}
	} else {
		approvedAt = createdAt
	}
	if _, err := h.DB.Exec(`INSERT INTO sessions(
		id,user_id,expires_at,created_at,device_name,device_type,user_agent,ip_address,last_seen_at,
		approved_at,approval_token_hash,approval_code_hash,approval_expires_at,trusted_device_id,
		requested_device_key_id,requested_device_public_key,device_challenge_hash,device_challenge_expires_at)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, userID, expires.Format(time.RFC3339Nano), createdAt, deviceName, deviceType, truncateSessionText(r.UserAgent(), 512),
		truncateSessionText(clientAddress(r), 128), createdAt, approvedAt, approvalTokenHash, approvalCodeHash, approvalExpiresAt,
		trustedDeviceID, nullableSessionText(input.DeviceKeyID), nullableSessionText(input.DevicePublicKey), deviceChallengeHash, deviceChallengeExpiresAt); err != nil {
		return sessionCreation{}, err
	}
	cookie := &http.Cookie{
		Name: sessionCookie, Value: id, Path: "/", HttpOnly: true,
		SameSite: h.cookieSameSite(), Secure: h.SecureCookies,
	}
	if persistent {
		cookie.Expires = expires
	}
	http.SetCookie(w, cookie)
	return creation, nil
}

func nullableSessionText(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.TrimSpace(value)
}

func (h *Handler) deleteSession(w http.ResponseWriter, r *http.Request) {
	if sessionID, ok := requestSessionID(r); ok {
		_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=?`, sessionID)
		h.sessionActivity().forget(sessionID)
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true,
		SameSite: h.cookieSameSite(), Secure: h.SecureCookies, MaxAge: -1,
	})
}

func (h *Handler) cookieSameSite() http.SameSite {
	if h.CookieSameSite != 0 {
		return h.CookieSameSite
	}
	return http.SameSiteLaxMode
}

func requestSessionID(r *http.Request) (string, bool) {
	if cookie, err := r.Cookie(sessionCookie); err == nil && cookie.Value != "" {
		return cookie.Value, true
	}
	auth := strings.TrimSpace(r.Header.Get("Authorization"))
	token, ok := strings.CutPrefix(auth, "Bearer ")
	if ok {
		token = strings.TrimSpace(token)
		return token, token != ""
	}
	if r.Method == http.MethodGet && r.URL.Path == "/api/ws" {
		for protocol := range strings.SplitSeq(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
			token, ok = strings.CutPrefix(strings.TrimSpace(protocol), websocketSessionProtocolPrefix)
			if ok {
				token = strings.TrimSpace(token)
				return token, token != ""
			}
		}
	}
	return "", false
}

func (h *Handler) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessionID, ok := requestSessionID(r)
		if !ok {
			httpx.Error(w, http.StatusUnauthorized, "authentication required")
			return
		}
		var userID int64
		var username string
		var expires string
		var approvedAt, approvalExpiresAt sql.NullString
		var isAdmin, isManager, isBanned bool
		err := h.DB.QueryRow(`SELECT s.user_id,u.username,s.expires_at,s.approved_at,s.approval_expires_at,u.is_admin,u.is_manager,u.is_banned
			FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`, sessionID).
			Scan(&userID, &username, &expires, &approvedAt, &approvalExpiresAt, &isAdmin, &isManager, &isBanned)
		if err != nil {
			if err != sql.ErrNoRows {
				httpx.Error(w, http.StatusInternalServerError, "session lookup failed")
				return
			}
			httpx.Error(w, http.StatusUnauthorized, "authentication required")
			return
		}
		expiry, err := time.Parse(time.RFC3339Nano, expires)
		if err != nil || time.Now().After(expiry) {
			_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=?`, sessionID)
			httpx.Error(w, http.StatusUnauthorized, "session expired")
			return
		}
		if !approvedAt.Valid {
			if approvalExpiresAt.Valid {
				deadline, parseErr := time.Parse(time.RFC3339Nano, approvalExpiresAt.String)
				if parseErr != nil || time.Now().After(deadline) {
					_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=?`, sessionID)
					httpx.Error(w, http.StatusUnauthorized, "session approval expired")
					return
				}
			}
			httpx.Error(w, http.StatusForbidden, "session approval required")
			return
		}
		if isBanned {
			_, _ = h.DB.Exec(`DELETE FROM sessions WHERE user_id=?`, userID)
			httpx.Error(w, http.StatusForbidden, "account banned")
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, userID)
		ctx = context.WithValue(ctx, usernameKey, username)
		ctx = context.WithValue(ctx, adminKey, isAdmin)
		ctx = context.WithValue(ctx, managerKey, isManager)
		ctx = context.WithValue(ctx, sessionIDKey, sessionID)
		h.touchSession(sessionID, truncateSessionText(clientAddress(r), 128))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h *Handler) AdminMiddleware(next http.Handler) http.Handler {
	return h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsAdmin(r) {
			httpx.Error(w, http.StatusForbidden, "administrator access required")
			return
		}
		if !h.allowAdministrationRequest(w, r) {
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (h *Handler) AdminAccessMiddleware(next http.Handler) http.Handler {
	return h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsAdmin(r) && !IsManager(r) {
			httpx.Error(w, http.StatusForbidden, "administrator access required")
			return
		}
		if !h.allowAdministrationRequest(w, r) {
			return
		}
		next.ServeHTTP(w, r)
	}))
}

func (h *Handler) adminAccessController() *adminaccess.Controller {
	if h.AdminAccess != nil {
		return h.AdminAccess
	}
	return adminaccess.NewController(h.DB, nil)
}

func (h *Handler) allowAdministrationRequest(w http.ResponseWriter, r *http.Request) bool {
	decision, err := h.adminAccessController().Decide(r)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "administration access policy lookup failed")
		return false
	}
	if !decision.Allowed {
		httpx.Error(w, http.StatusForbidden, "administration access is not allowed from this IP address")
		return false
	}
	return true
}
