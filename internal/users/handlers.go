package users

import (
	"database/sql"
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/userdiscovery"
	"golang.org/x/crypto/bcrypt"
)

type Broadcaster interface {
	SendToUser(userID int64, event any) bool
}

type Handler struct {
	DB  *sql.DB
	Hub Broadcaster
}

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

type User struct {
	ID               int64   `json:"id"`
	Username         string  `json:"username"`
	DisplayName      string  `json:"display_name"`
	Description      string  `json:"description"`
	PublicKey        string  `json:"public_key"`
	SigningPublicKey string  `json:"signing_public_key"`
	SigningKeyID     string  `json:"signing_key_id"`
	Avatar           *string `json:"avatar"`
}

func (h *Handler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username        string  `json:"username"`
		DisplayName     string  `json:"display_name"`
		Description     string  `json:"description"`
		CurrentPassword string  `json:"current_password"`
		NewPassword     string  `json:"new_password"`
		Avatar          *string `json:"avatar"`
		IsDiscoverable  *bool   `json:"is_discoverable"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	input.Username = strings.ToLower(strings.TrimSpace(input.Username))
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.Description = strings.TrimSpace(input.Description)
	if !usernamePattern.MatchString(input.Username) {
		httpx.Error(w, http.StatusBadRequest, "invalid username")
		return
	}
	if len(input.DisplayName) < 1 || len(input.DisplayName) > 80 {
		httpx.Error(w, http.StatusBadRequest, "invalid display name")
		return
	}
	if len([]rune(input.Description)) > 280 {
		httpx.Error(w, http.StatusBadRequest, "invalid description")
		return
	}
	if input.NewPassword != "" && (len(input.NewPassword) < 8 || len(input.NewPassword) > 256) {
		httpx.Error(w, http.StatusBadRequest, "invalid new password")
		return
	}
	if input.Avatar != nil && !validAvatar(*input.Avatar) {
		httpx.Error(w, http.StatusBadRequest, "invalid avatar")
		return
	}

	userID := auth.UserID(r)
	var currentUsername, currentHash, currentDisplayName string
	var currentDiscoverable bool
	if err := h.DB.QueryRow(`SELECT username,password_hash,display_name,is_discoverable FROM users WHERE id=?`, userID).
		Scan(&currentUsername, &currentHash, &currentDisplayName, &currentDiscoverable); err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	if !strings.EqualFold(input.DisplayName, currentDisplayName) {
		var displayNameCount int
		if err := h.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE id<>? AND lower(display_name)=lower(?)`, userID, input.DisplayName).Scan(&displayNameCount); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "user lookup failed")
			return
		}
		if displayNameCount > 0 {
			httpx.Error(w, http.StatusConflict, "display name already exists")
			return
		}
	}
	if input.NewPassword != "" || input.Username != currentUsername {
		if bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(input.CurrentPassword)) != nil {
			httpx.Error(w, http.StatusUnauthorized, "current password is incorrect")
			return
		}
	}
	if input.NewPassword != "" {
		newHash, err := bcrypt.GenerateFromPassword([]byte(input.NewPassword), 12)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "password hashing failed")
			return
		}
		currentHash = string(newHash)
	}
	nextDiscoverable := currentDiscoverable
	if input.IsDiscoverable != nil {
		nextDiscoverable = *input.IsDiscoverable
	}
	if _, err := h.DB.Exec(`UPDATE users SET username=?,display_name=?,description=?,password_hash=?,avatar=?,is_discoverable=? WHERE id=?`,
		input.Username, input.DisplayName, input.Description, currentHash, input.Avatar, nextDiscoverable, userID); err != nil {
		httpx.Error(w, http.StatusConflict, "username already exists")
		return
	}

	var user User
	var isDiscoverable bool
	var discoveryCodeHash sql.NullString
	if err := h.DB.QueryRow(`SELECT id,username,display_name,description,public_key,signing_public_key,signing_key_id,avatar,
		is_discoverable,discovery_code_hash FROM users WHERE id=?`, userID).
		Scan(&user.ID, &user.Username, &user.DisplayName, &user.Description, &user.PublicKey, &user.SigningPublicKey, &user.SigningKeyID,
			&user.Avatar, &isDiscoverable, &discoveryCodeHash); err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	h.notifyProfileUpdate(userID)
	httpx.JSON(w, http.StatusOK, struct {
		User
		IsDiscoverable   bool `json:"is_discoverable"`
		HasDiscoveryCode bool `json:"has_discovery_code"`
	}{
		User:             user,
		IsDiscoverable:   isDiscoverable,
		HasDiscoveryCode: discoveryCodeHash.Valid && discoveryCodeHash.String != "",
	})
}

func (h *Handler) notifyProfileUpdate(userID int64) {
	if h.Hub == nil {
		return
	}
	rows, err := h.DB.Query(`SELECT cm1.conversation_id,cm2.user_id
		FROM conversation_members cm1
		JOIN conversation_members cm2 ON cm2.conversation_id=cm1.conversation_id
		WHERE cm1.user_id=?`, userID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var conversationID, recipientID int64
		if rows.Scan(&conversationID, &recipientID) == nil {
			h.Hub.SendToUser(recipientID, map[string]any{
				"type": "conversation_updated", "conversation_id": conversationID, "profile_updated": true, "user_id": userID,
			})
		}
	}
}

func (h *Handler) Search(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	role := ""
	if r.Method == http.MethodPost {
		var input struct {
			Query string `json:"query"`
			Role  string `json:"role"`
		}
		if !httpx.Decode(w, r, &input) {
			return
		}
		query = strings.TrimSpace(input.Query)
		role = strings.ToLower(strings.TrimSpace(input.Role))
	}
	if role == "" {
		switch strings.ToLower(strings.TrimSpace(query)) {
		case "administrateur", "administrateurs":
			role = "administrator"
		case "gestionnaire", "gestionnaires":
			role = "manager"
		}
	}
	requesterID := auth.UserID(r)
	if role != "" {
		roleColumn := ""
		switch role {
		case "administrator":
			roleColumn = "u.is_admin=1"
		case "manager":
			roleColumn = "u.is_manager=1"
		default:
			httpx.Error(w, http.StatusBadRequest, "invalid directory role")
			return
		}
		rows, err := h.DB.Query(`SELECT u.id,u.username,u.display_name,u.description,u.public_key,u.signing_public_key,u.signing_key_id,u.avatar FROM users u
			WHERE u.is_remote=0 AND u.is_banned=0 AND `+roleColumn+`
			AND (u.id=? OR u.is_discoverable=1
				OR EXISTS(SELECT 1 FROM contacts c WHERE (c.owner_id=? AND c.contact_user_id=u.id) OR (c.owner_id=u.id AND c.contact_user_id=?))
				OR EXISTS(SELECT 1 FROM conversation_members mine JOIN conversation_members peer ON peer.conversation_id=mine.conversation_id
					WHERE mine.user_id=? AND mine.role<>'pending' AND peer.user_id=u.id AND peer.role<>'pending'))
			ORDER BY u.username`, requesterID, requesterID, requesterID, requesterID)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "search failed")
			return
		}
		h.writeSearchResults(w, rows)
		return
	}
	if codeHash := userdiscovery.HashCode(query); codeHash != "" {
		if r.Method != http.MethodPost {
			httpx.JSON(w, http.StatusOK, []User{})
			return
		}
		rows, err := h.DB.Query(`SELECT id,username,display_name,description,public_key,signing_public_key,signing_key_id,avatar FROM users
			WHERE id<>? AND is_remote=0 AND is_banned=0 AND discovery_code_hash=? LIMIT 1`, requesterID, codeHash)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "search failed")
			return
		}
		h.writeSearchResults(w, rows)
		return
	}
	query = strings.ToLower(query)
	if len(query) < 2 || len(query) > 32 {
		httpx.JSON(w, http.StatusOK, []User{})
		return
	}
	rows, err := h.DB.Query(`SELECT u.id,u.username,u.display_name,u.description,u.public_key,u.signing_public_key,u.signing_key_id,u.avatar FROM users u
		WHERE u.id<>? AND u.is_remote=0 AND u.is_banned=0 AND u.username LIKE ?
		AND (u.is_discoverable=1
			OR EXISTS(SELECT 1 FROM contacts c WHERE (c.owner_id=? AND c.contact_user_id=u.id) OR (c.owner_id=u.id AND c.contact_user_id=?))
			OR EXISTS(SELECT 1 FROM conversation_members mine JOIN conversation_members peer ON peer.conversation_id=mine.conversation_id
				WHERE mine.user_id=? AND mine.role<>'pending' AND peer.user_id=u.id AND peer.role<>'pending'))
		ORDER BY u.username LIMIT 20`, requesterID, query+"%", requesterID, requesterID, requesterID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "search failed")
		return
	}
	h.writeSearchResults(w, rows)
}

func (h *Handler) writeSearchResults(w http.ResponseWriter, rows *sql.Rows) {
	defer rows.Close()
	result := make([]User, 0)
	for rows.Next() {
		var user User
		if rows.Scan(&user.ID, &user.Username, &user.DisplayName, &user.Description, &user.PublicKey, &user.SigningPublicKey, &user.SigningKeyID, &user.Avatar) == nil {
			result = append(result, user)
		}
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) GenerateDiscoveryCode(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Password string `json:"password"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	userID := auth.UserID(r)
	var passwordHash string
	var discoverable bool
	if err := h.DB.QueryRow(`SELECT password_hash,is_discoverable FROM users WHERE id=? AND is_remote=0 AND is_banned=0`, userID).
		Scan(&passwordHash, &discoverable); err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	if discoverable {
		httpx.Error(w, http.StatusConflict, "profile must be invisible")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(input.Password)) != nil {
		httpx.Error(w, http.StatusUnauthorized, "current password is incorrect")
		return
	}
	code, codeHash, err := userdiscovery.GenerateCode()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "discovery code generation failed")
		return
	}
	createdAt := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := h.DB.Exec(`UPDATE users SET discovery_code_hash=?,discovery_code_created_at=? WHERE id=?`, codeHash, createdAt, userID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "discovery code generation failed")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"discovery_code": code,
		"created_at":     createdAt,
	})
}

func validAvatar(value string) bool {
	if value == "" {
		return false
	}
	var encoded string
	switch {
	case strings.HasPrefix(value, "data:image/webp;base64,"):
		encoded = strings.TrimPrefix(value, "data:image/webp;base64,")
	case strings.HasPrefix(value, "data:image/jpeg;base64,"):
		encoded = strings.TrimPrefix(value, "data:image/jpeg;base64,")
	case strings.HasPrefix(value, "data:image/png;base64,"):
		encoded = strings.TrimPrefix(value, "data:image/png;base64,")
	default:
		return false
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	return err == nil && len(data) > 0 && len(data) <= 256<<10
}
