package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"net/http"
	"strings"
	"time"

	"chat-pwa-go/internal/httpx"
)

type contextKey string

const userIDKey contextKey = "user_id"
const adminKey contextKey = "is_admin"
const managerKey contextKey = "is_manager"
const sessionCookie = "chat_session"
const websocketSessionProtocolPrefix = "vibration-auth."
const shortSessionDuration = 12 * time.Hour
const longSessionDuration = 30 * 24 * time.Hour

func UserID(r *http.Request) int64 {
	value, _ := r.Context().Value(userIDKey).(int64)
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

func (h *Handler) createSession(w http.ResponseWriter, userID int64, persistent bool) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	id := base64.RawURLEncoding.EncodeToString(raw)
	now := time.Now().UTC()
	duration := shortSessionDuration
	if persistent {
		duration = longSessionDuration
	}
	expires := now.Add(duration)
	if _, err := h.DB.Exec(`INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)`,
		id, userID, expires.Format(time.RFC3339Nano), now.Format(time.RFC3339Nano)); err != nil {
		return "", err
	}
	cookie := &http.Cookie{
		Name: sessionCookie, Value: id, Path: "/", HttpOnly: true,
		SameSite: h.cookieSameSite(), Secure: h.SecureCookies,
	}
	if persistent {
		cookie.Expires = expires
	}
	http.SetCookie(w, cookie)
	return id, nil
}

func (h *Handler) deleteSession(w http.ResponseWriter, r *http.Request) {
	if sessionID, ok := requestSessionID(r); ok {
		_, _ = h.DB.Exec(`DELETE FROM sessions WHERE id=?`, sessionID)
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
		var expires string
		var isAdmin, isManager, isBanned bool
		err := h.DB.QueryRow(`SELECT s.user_id,s.expires_at,u.is_admin,u.is_manager,u.is_banned
			FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=?`, sessionID).
			Scan(&userID, &expires, &isAdmin, &isManager, &isBanned)
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
		if isBanned {
			_, _ = h.DB.Exec(`DELETE FROM sessions WHERE user_id=?`, userID)
			httpx.Error(w, http.StatusForbidden, "account banned")
			return
		}
		ctx := context.WithValue(r.Context(), userIDKey, userID)
		ctx = context.WithValue(ctx, adminKey, isAdmin)
		ctx = context.WithValue(ctx, managerKey, isManager)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h *Handler) AdminMiddleware(next http.Handler) http.Handler {
	return h.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !IsAdmin(r) {
			httpx.Error(w, http.StatusForbidden, "administrator access required")
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
		next.ServeHTTP(w, r)
	}))
}
