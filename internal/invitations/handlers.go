package invitations

import (
	"database/sql"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/invitationstore"
)

type Handler struct {
	DB          *sql.DB
	AuthLimiter *auth.RateLimiter
}

type invitationInput struct {
	FirstName        string `json:"first_name"`
	LastName         string `json:"last_name"`
	Email            string `json:"email"`
	Phone            string `json:"phone"`
	Code             string `json:"code"`
	ExpiresInSeconds int64  `json:"expires_in_seconds"`
}

type invitationRecord struct {
	ID        int64   `json:"id"`
	FirstName string  `json:"first_name"`
	LastName  string  `json:"last_name"`
	Email     string  `json:"email"`
	Phone     string  `json:"phone"`
	ExpiresAt string  `json:"expires_at"`
	UsedAt    *string `json:"used_at"`
	RevokedAt *string `json:"revoked_at"`
	CreatedAt string  `json:"created_at"`
	Active    bool    `json:"active"`
}

var allowedDurations = map[int64]time.Duration{
	3600:    time.Hour,
	86400:   24 * time.Hour,
	604800:  7 * 24 * time.Hour,
	2592000: 30 * 24 * time.Hour,
	7776000: 90 * 24 * time.Hour,
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	var input invitationInput
	if !httpx.Decode(w, r, &input) {
		return
	}
	firstName := strings.TrimSpace(input.FirstName)
	lastName := strings.TrimSpace(input.LastName)
	email := strings.TrimSpace(input.Email)
	phone := strings.TrimSpace(input.Phone)
	code, err := invitationstore.NormalizeCode(input.Code)
	if err != nil || len([]rune(firstName)) > 80 || len([]rune(lastName)) > 80 ||
		len([]rune(email)) > 320 || len([]rune(phone)) > 64 ||
		(firstName == "" && lastName == "") || (email == "" && phone == "") {
		httpx.Error(w, http.StatusBadRequest, "invalid invitation contact")
		return
	}
	if email != "" && (!strings.Contains(email, "@") || strings.ContainsAny(email, "\r\n")) {
		httpx.Error(w, http.StatusBadRequest, "invalid invitation email")
		return
	}
	duration, ok := allowedDurations[input.ExpiresInSeconds]
	if !ok {
		httpx.Error(w, http.StatusBadRequest, "invalid invitation expiration")
		return
	}
	now := time.Now().UTC()
	expiresAt := now.Add(duration).Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`INSERT INTO invitation_contacts(created_by,first_name,last_name,email,phone,code_hash,expires_at,created_at)
		VALUES(?,?,?,?,?,?,?,?)`, auth.UserID(r), firstName, lastName, email, phone,
		invitationstore.HashCode(code), expiresAt, now.Format(time.RFC3339Nano))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") || strings.Contains(strings.ToLower(err.Error()), "duplicate") {
			httpx.Error(w, http.StatusConflict, "invitation code already exists")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "invitation creation failed")
		return
	}
	id, _ := result.LastInsertId()
	_ = h.audit(r, id, "invitation_created", firstName+" "+lastName)
	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id":         id,
		"code":       code,
		"url":        invitationURL(r, code),
		"first_name": firstName,
		"last_name":  lastName,
		"email":      email,
		"phone":      phone,
		"expires_at": expiresAt,
		"created_at": now.Format(time.RFC3339Nano),
	})
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	paged := r.URL.Query().Has("page")
	query := `SELECT id,first_name,last_name,email,phone,expires_at,used_at,revoked_at,created_at
		FROM invitation_contacts ORDER BY id DESC`
	args := make([]any, 0, 2)
	total, page, limit, offset, totalPages := 0, 1, 0, 0, 1
	if paged {
		if err := h.DB.QueryRow(`SELECT COUNT(*) FROM invitation_contacts`).Scan(&total); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "invitation count failed")
			return
		}
		page, limit, offset, totalPages = invitationPagination(r, total)
		query += ` LIMIT ? OFFSET ?`
		args = append(args, limit, offset)
	}
	rows, err := h.DB.Query(query, args...)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "invitation lookup failed")
		return
	}
	defer rows.Close()
	now := time.Now().UTC()
	items := make([]invitationRecord, 0)
	for rows.Next() {
		var item invitationRecord
		var usedAt, revokedAt sql.NullString
		if rows.Scan(&item.ID, &item.FirstName, &item.LastName, &item.Email, &item.Phone,
			&item.ExpiresAt, &usedAt, &revokedAt, &item.CreatedAt) != nil {
			continue
		}
		item.UsedAt = nullable(usedAt)
		item.RevokedAt = nullable(revokedAt)
		deadline, parseErr := time.Parse(time.RFC3339Nano, item.ExpiresAt)
		item.Active = !usedAt.Valid && !revokedAt.Valid && parseErr == nil && deadline.After(now)
		items = append(items, item)
	}
	if paged {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"items":       items,
			"page":        page,
			"page_size":   limit,
			"total":       total,
			"total_pages": totalPages,
		})
		return
	}
	httpx.JSON(w, http.StatusOK, items)
}

func (h *Handler) Revoke(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE invitation_contacts SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND used_at IS NULL`, now, id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "invitation revocation failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		httpx.Error(w, http.StatusNotFound, "invitation not found")
		return
	}
	_ = h.audit(r, id, "invitation_revoked", "")
	httpx.JSON(w, http.StatusOK, map[string]any{"revoked": true, "revoked_at": now})
}

// Landing validates the code before sending the recipient to registration.
// The code remains in the query only long enough for login.js to submit it;
// it is never stored in a cookie or server session.
func (h *Handler) Landing(w http.ResponseWriter, r *http.Request) {
	if h.AuthLimiter != nil && !h.AuthLimiter.Allow("invitation:"+requestIP(r)) {
		httpx.Error(w, http.StatusTooManyRequests, "too many authentication attempts")
		return
	}
	code := strings.TrimSpace(r.PathValue("code"))
	_, valid, err := invitationstore.ActiveID(h.DB, code, time.Now().UTC())
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "invitation lookup failed")
		return
	}
	if !valid {
		httpx.Error(w, http.StatusGone, "invitation unavailable")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/login.html?mode=register&invitation="+url.QueryEscape(code), http.StatusSeeOther)
}

func requestIP(r *http.Request) string {
	if forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0]); forwarded != "" {
		return forwarded
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func invitationURL(r *http.Request, code string) string {
	scheme := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
	if scheme != "http" && scheme != "https" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := r.Host
	if host == "" {
		return "/invite/" + url.PathEscape(code)
	}
	return scheme + "://" + host + "/invite/" + url.PathEscape(code)
}

func nullable(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	result := value.String
	return &result
}

func invitationPagination(r *http.Request, total int) (page, limit, offset, totalPages int) {
	limit, _ = strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 10
	}
	totalPages = (total + limit - 1) / limit
	if totalPages < 1 {
		totalPages = 1
	}
	page, _ = strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	if page > totalPages {
		page = totalPages
	}
	return page, limit, (page - 1) * limit, totalPages
}

func (h *Handler) audit(r *http.Request, id int64, action, details string) error {
	_, err := h.DB.Exec(`INSERT INTO admin_actions(admin_id,action,details,created_at) VALUES(?,?,?,?)`,
		auth.UserID(r), action, details, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}
