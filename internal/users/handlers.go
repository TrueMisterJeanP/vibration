package users

import (
	"database/sql"
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
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
	ID          int64   `json:"id"`
	Username    string  `json:"username"`
	DisplayName string  `json:"display_name"`
	Description string  `json:"description"`
	PublicKey   string  `json:"public_key"`
	Avatar      *string `json:"avatar"`
}

func (h *Handler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username        string  `json:"username"`
		DisplayName     string  `json:"display_name"`
		Description     string  `json:"description"`
		CurrentPassword string  `json:"current_password"`
		NewPassword     string  `json:"new_password"`
		Avatar          *string `json:"avatar"`
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
	if err := h.DB.QueryRow(`SELECT username,password_hash,display_name FROM users WHERE id=?`, userID).
		Scan(&currentUsername, &currentHash, &currentDisplayName); err != nil {
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
	if _, err := h.DB.Exec(`UPDATE users SET username=?,display_name=?,description=?,password_hash=?,avatar=? WHERE id=?`,
		input.Username, input.DisplayName, input.Description, currentHash, input.Avatar, userID); err != nil {
		httpx.Error(w, http.StatusConflict, "username already exists")
		return
	}

	var user User
	if err := h.DB.QueryRow(`SELECT id,username,display_name,description,public_key,avatar FROM users WHERE id=?`, userID).
		Scan(&user.ID, &user.Username, &user.DisplayName, &user.Description, &user.PublicKey, &user.Avatar); err != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	h.notifyProfileUpdate(userID)
	httpx.JSON(w, http.StatusOK, user)
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
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if len(query) < 2 || len(query) > 32 {
		httpx.JSON(w, http.StatusOK, []User{})
		return
	}
	rows, err := h.DB.Query(`SELECT id,username,display_name,description,public_key,avatar FROM users
		WHERE id<>? AND is_remote=0 AND username LIKE ? ORDER BY username LIMIT 20`, auth.UserID(r), query+"%")
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "search failed")
		return
	}
	defer rows.Close()
	result := make([]User, 0)
	for rows.Next() {
		var user User
		if rows.Scan(&user.ID, &user.Username, &user.DisplayName, &user.Description, &user.PublicKey, &user.Avatar) == nil {
			result = append(result, user)
		}
	}
	httpx.JSON(w, http.StatusOK, result)
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
