package auth

import (
	"database/sql"
	"net/http"
	"strings"
	"time"

	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/settings"
)

func (h *Handler) Terms(w http.ResponseWriter, _ *http.Request) {
	terms, err := settings.LoadTerms(h.DB)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "terms lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, terms)
}

func (h *Handler) TermsStatus(w http.ResponseWriter, r *http.Request) {
	terms, err := settings.LoadTerms(h.DB)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "terms lookup failed")
		return
	}
	accepted, err := settings.TermsAccepted(h.DB, UserID(r), terms.Version)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "terms lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"content": terms.Content, "version": terms.Version, "updated_at": terms.UpdatedAt,
		"accepted": accepted, "acceptance_required": !accepted,
	})
}

func (h *Handler) AcceptTerms(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Version int64 `json:"version"`
		Accept  bool  `json:"accept"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	terms, err := settings.LoadTerms(h.DB)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "terms lookup failed")
		return
	}
	if !input.Accept || input.Version != terms.Version {
		httpx.Error(w, http.StatusConflict, "current terms must be accepted")
		return
	}
	if err := settings.AcceptTerms(h.DB, UserID(r), terms.Version); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "terms acceptance failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"accepted": true, "version": terms.Version})
}

// TermsMiddleware prevents an authenticated session from using application APIs
// until it has accepted the current terms version. Public and acceptance routes
// remain reachable so a user can authenticate, read, accept, or log out.
func (h *Handler) TermsMiddleware(next http.Handler) http.Handler {
	allowed := map[string]bool{
		"/api/edition": true, "/api/registration": true, "/api/register": true,
		"/api/login": true, "/api/password/reset": true, "/api/terms": true,
		"/api/terms/status": true, "/api/terms/accept": true, "/api/me": true,
		"/api/logout": true,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") || allowed[r.URL.Path] ||
			(r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/file-shares/")) {
			next.ServeHTTP(w, r)
			return
		}
		sessionID, ok := requestSessionID(r)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		var userID int64
		var expires string
		err := h.DB.QueryRow(`SELECT s.user_id,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
			WHERE s.id=? AND u.is_banned=0`, sessionID).Scan(&userID, &expires)
		if err == sql.ErrNoRows {
			next.ServeHTTP(w, r)
			return
		}
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "session lookup failed")
			return
		}
		expiry, err := time.Parse(time.RFC3339Nano, expires)
		if err != nil || time.Now().After(expiry) {
			next.ServeHTTP(w, r)
			return
		}
		terms, err := settings.LoadTerms(h.DB)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "terms lookup failed")
			return
		}
		accepted, err := settings.TermsAccepted(h.DB, userID, terms.Version)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "terms lookup failed")
			return
		}
		if !accepted {
			httpx.JSON(w, http.StatusForbidden, map[string]any{
				"error": "Vous devez accepter les conditions d’utilisation pour continuer.", "code": "terms_acceptance_required", "terms_version": terms.Version,
			})
			return
		}
		next.ServeHTTP(w, r)
	})
}
