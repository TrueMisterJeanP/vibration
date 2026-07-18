package conversations

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/httpx"
)

type Broadcaster interface {
	SendToUser(userID int64, event any) bool
}

type FederationRouter interface {
	QueueGroupCreate(conversationID int64)
	QueueGroupAccept(conversationID, userID int64)
	QueueGroupUpdate(conversationID int64)
	QueueGroupDelete(conversationID, userID int64)
	QueueGroupMemberAdd(conversationID, memberID int64)
	QueueGroupMemberRemove(conversationID, memberID int64)
}

type Handler struct {
	DB         *sql.DB
	Hub        Broadcaster
	Federation FederationRouter
}

type Conversation struct {
	ID                       int64   `json:"id"`
	Type                     string  `json:"type"`
	EncryptedTitle           *string `json:"encrypted_title"`
	EncryptedDescription     *string `json:"encrypted_description"`
	EncryptedAvatar          *string `json:"encrypted_avatar"`
	FederationKeyID          *string `json:"federation_key_id"`
	FederationInstanceURL    *string `json:"federation_instance_url"`
	RemoteUsername           *string `json:"remote_username"`
	CreatedBy                int64   `json:"created_by"`
	CreatedAt                string  `json:"created_at"`
	EncryptedConversationKey string  `json:"encrypted_conversation_key"`
	Role                     string  `json:"role"`
	LastMessageAt            *string `json:"last_message_at"`
	LastMessageEncrypted     *string `json:"last_message_encrypted_content"`
	LastMessageIV            *string `json:"last_message_iv"`
	LastMessageHasFile       bool    `json:"last_message_has_file"`
	UnreadCount              int     `json:"unread_count"`
}

type Member struct {
	UserID                   int64   `json:"user_id"`
	Username                 string  `json:"username"`
	DisplayName              string  `json:"display_name"`
	Description              string  `json:"description"`
	PublicKey                string  `json:"public_key"`
	Avatar                   *string `json:"avatar"`
	IsRemote                 bool    `json:"is_remote"`
	FederationInstanceURL    *string `json:"federation_instance_url"`
	RemoteUsername           *string `json:"remote_username"`
	EncryptedConversationKey string  `json:"encrypted_conversation_key"`
	Role                     string  `json:"role"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	rows, err := h.DB.Query(`SELECT c.id,c.type,c.encrypted_title,c.encrypted_description,c.encrypted_avatar,c.federation_key_id,fi.base_url,ru.remote_username,
		c.created_by,c.created_at,cm.encrypted_conversation_key,cm.role,
		(SELECT MAX(created_at) FROM messages WHERE conversation_id=c.id AND created_at>=cm.created_at AND (expires_at IS NULL OR expires_at>?)),
		(SELECT encrypted_content FROM messages WHERE conversation_id=c.id AND created_at>=cm.created_at AND (expires_at IS NULL OR expires_at>?) ORDER BY id DESC LIMIT 1),
		(SELECT iv FROM messages WHERE conversation_id=c.id AND created_at>=cm.created_at AND (expires_at IS NULL OR expires_at>?) ORDER BY id DESC LIMIT 1),
		COALESCE((SELECT f.id IS NOT NULL FROM messages lm LEFT JOIN files f ON f.message_id=lm.id WHERE lm.conversation_id=c.id AND lm.created_at>=cm.created_at AND (lm.expires_at IS NULL OR lm.expires_at>?) ORDER BY lm.id DESC LIMIT 1),0),
		(SELECT COUNT(*) FROM messages m JOIN message_receipts mr ON mr.message_id=m.id
		WHERE m.conversation_id=c.id AND m.created_at>=cm.created_at AND mr.user_id=? AND mr.status<>'read' AND (m.expires_at IS NULL OR m.expires_at>?))
		FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
		LEFT JOIN federated_conversations fc ON fc.local_conversation_id=c.id
		LEFT JOIN federated_instances fi ON fi.id=fc.instance_id
		LEFT JOIN users ru ON ru.id=fc.remote_user_id
		WHERE cm.user_id=? ORDER BY COALESCE((SELECT MAX(id) FROM messages WHERE conversation_id=c.id AND created_at>=cm.created_at AND (expires_at IS NULL OR expires_at>?)),0) DESC,c.id DESC`, now, now, now, now, auth.UserID(r), now, auth.UserID(r), now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "conversation lookup failed")
		return
	}
	defer rows.Close()
	result := make([]Conversation, 0)
	for rows.Next() {
		var item Conversation
		if rows.Scan(&item.ID, &item.Type, &item.EncryptedTitle, &item.EncryptedDescription, &item.EncryptedAvatar, &item.FederationKeyID,
			&item.FederationInstanceURL, &item.RemoteUsername, &item.CreatedBy, &item.CreatedAt, &item.EncryptedConversationKey, &item.Role, &item.LastMessageAt,
			&item.LastMessageEncrypted, &item.LastMessageIV, &item.LastMessageHasFile, &item.UnreadCount) == nil {
			result = append(result, item)
		}
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) CreatePrivate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		UserID int64 `json:"user_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	ownerID := auth.UserID(r)
	if input.UserID <= 0 || input.UserID == ownerID {
		httpx.Error(w, http.StatusBadRequest, "invalid participant")
		return
	}
	var exists int
	if h.DB.QueryRow(`SELECT COUNT(*) FROM users WHERE id=? AND is_remote=0`, input.UserID).Scan(&exists) != nil || exists != 1 {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	if !h.hasAcceptedContact(ownerID, input.UserID) {
		httpx.Error(w, http.StatusForbidden, "contact acceptance required")
		return
	}
	var existing int64
	err := h.DB.QueryRow(`SELECT c.id FROM conversations c
		JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=?
		JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=?
		WHERE c.type='private' AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id=c.id)=2 LIMIT 1`,
		ownerID, input.UserID).Scan(&existing)
	if err == nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"id": existing, "existing": true})
		return
	}
	id, err := h.createConversation("private", nil, nil, nil, ownerID, map[int64]string{ownerID: "ecdh-v1", input.UserID: "ecdh-v1"}, nil)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "conversation creation failed")
		return
	}
	h.notifyMembers(id, "conversation_updated")
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (h *Handler) CreateGroup(w http.ResponseWriter, r *http.Request) {
	var input struct {
		EncryptedTitle       string            `json:"encrypted_title"`
		EncryptedDescription *string           `json:"encrypted_description"`
		EncryptedAvatar      *string           `json:"encrypted_avatar"`
		MemberIDs            []int64           `json:"member_ids"`
		EncryptedKeys        map[string]string `json:"encrypted_keys"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	ownerID := auth.UserID(r)
	set := map[int64]bool{ownerID: true}
	for _, id := range input.MemberIDs {
		if id > 0 {
			set[id] = true
		}
	}
	if len(set) < 2 || len(set) > 100 || len(input.EncryptedTitle) < 10 {
		httpx.Error(w, http.StatusBadRequest, "invalid group")
		return
	}
	if input.EncryptedDescription != nil && (len(*input.EncryptedDescription) < 10 || len(*input.EncryptedDescription) > 8192) {
		httpx.Error(w, http.StatusBadRequest, "invalid group")
		return
	}
	if input.EncryptedAvatar != nil && (len(*input.EncryptedAvatar) < 10 || len(*input.EncryptedAvatar) > 512<<10) {
		httpx.Error(w, http.StatusBadRequest, "invalid group")
		return
	}
	for id := range set {
		if id != ownerID && !h.hasAcceptedContact(ownerID, id) {
			httpx.Error(w, http.StatusForbidden, "contact acceptance required")
			return
		}
	}
	var remoteMembers int
	for id := range set {
		var remote bool
		if h.DB.QueryRow(`SELECT is_remote FROM users WHERE id=?`, id).Scan(&remote) != nil {
			httpx.Error(w, http.StatusNotFound, "user not found")
			return
		}
		if remote {
			remoteMembers++
		}
	}
	if remoteMembers > 1 {
		httpx.Error(w, http.StatusBadRequest, "a federated group currently supports one remote participant")
		return
	}
	keys := make(map[int64]string, len(set))
	roles := make(map[int64]string, len(set))
	for id := range set {
		key := input.EncryptedKeys[strconv.FormatInt(id, 10)]
		if len(key) < 10 {
			httpx.Error(w, http.StatusBadRequest, "missing encrypted group key")
			return
		}
		keys[id] = key
		if id != ownerID {
			roles[id] = "pending"
		}
	}
	id, err := h.createConversation("group", &input.EncryptedTitle, input.EncryptedDescription, input.EncryptedAvatar, ownerID, keys, roles)
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, "group creation failed")
		return
	}
	h.notifyMembers(id, "conversation_updated")
	if h.Federation != nil {
		h.Federation.QueueGroupCreate(id)
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id})
}

func (h *Handler) createConversation(kind string, title, description, avatar *string, ownerID int64, keys map[int64]string, roles map[int64]string) (int64, error) {
	tx, err := h.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.Exec(`INSERT INTO conversations(type,encrypted_title,encrypted_description,encrypted_avatar,created_by,created_at) VALUES(?,?,?,?,?,?)`,
		kind, title, description, avatar, ownerID, now)
	if err != nil {
		return 0, err
	}
	id, _ := result.LastInsertId()
	ids := make([]int64, 0, len(keys))
	for userID := range keys {
		ids = append(ids, userID)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, userID := range ids {
		role := "member"
		if userID == ownerID {
			role = "owner"
		} else if roles != nil && roles[userID] != "" {
			role = roles[userID]
		}
		result, err := tx.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
			SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)`, id, userID, keys[userID], role, now, userID)
		if err != nil {
			return 0, err
		}
		affected, _ := result.RowsAffected()
		if affected != 1 {
			return 0, sql.ErrNoRows
		}
	}
	return id, tx.Commit()
}

func (h *Handler) Get(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var conversation Conversation
	err = h.DB.QueryRow(`SELECT c.id,c.type,c.encrypted_title,c.encrypted_description,c.encrypted_avatar,c.federation_key_id,fi.base_url,ru.remote_username,
		c.created_by,c.created_at,cm.encrypted_conversation_key,cm.role,
		(SELECT MAX(created_at) FROM messages WHERE conversation_id=c.id AND created_at>=cm.created_at AND (expires_at IS NULL OR expires_at>?)),
		(SELECT encrypted_content FROM messages WHERE conversation_id=c.id AND created_at>=cm.created_at AND (expires_at IS NULL OR expires_at>?) ORDER BY id DESC LIMIT 1),
		(SELECT iv FROM messages WHERE conversation_id=c.id AND created_at>=cm.created_at AND (expires_at IS NULL OR expires_at>?) ORDER BY id DESC LIMIT 1),
		COALESCE((SELECT f.id IS NOT NULL FROM messages lm LEFT JOIN files f ON f.message_id=lm.id WHERE lm.conversation_id=c.id AND lm.created_at>=cm.created_at AND (lm.expires_at IS NULL OR lm.expires_at>?) ORDER BY lm.id DESC LIMIT 1),0),
		(SELECT COUNT(*) FROM messages m JOIN message_receipts mr ON mr.message_id=m.id
			WHERE m.conversation_id=c.id AND m.created_at>=cm.created_at AND mr.user_id=? AND mr.status<>'read' AND (m.expires_at IS NULL OR m.expires_at>?))
		FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
		LEFT JOIN federated_conversations fc ON fc.local_conversation_id=c.id
		LEFT JOIN federated_instances fi ON fi.id=fc.instance_id
		LEFT JOIN users ru ON ru.id=fc.remote_user_id
		WHERE c.id=? AND cm.user_id=?`, now, now, now, now, auth.UserID(r), now, id, auth.UserID(r)).
		Scan(&conversation.ID, &conversation.Type, &conversation.EncryptedTitle, &conversation.EncryptedDescription, &conversation.EncryptedAvatar,
			&conversation.FederationKeyID, &conversation.FederationInstanceURL, &conversation.RemoteUsername, &conversation.CreatedBy, &conversation.CreatedAt,
			&conversation.EncryptedConversationKey, &conversation.Role, &conversation.LastMessageAt, &conversation.LastMessageEncrypted, &conversation.LastMessageIV,
			&conversation.LastMessageHasFile, &conversation.UnreadCount)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	httpx.JSON(w, http.StatusOK, conversation)
}

func (h *Handler) Members(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.PathID(r, "id")
	if err != nil || !h.isMember(id, auth.UserID(r)) {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	rows, err := h.DB.Query(`SELECT u.id,COALESCE(u.remote_username,u.username),u.display_name,u.description,u.public_key,u.avatar,u.is_remote,fi.base_url,u.remote_username,cm.encrypted_conversation_key,cm.role
		FROM conversation_members cm JOIN users u ON u.id=cm.user_id
		LEFT JOIN federated_instances fi ON fi.id=u.remote_instance_id
		WHERE cm.conversation_id=? ORDER BY u.username`, id)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "members lookup failed")
		return
	}
	defer rows.Close()
	members := make([]Member, 0)
	for rows.Next() {
		var member Member
		if rows.Scan(&member.UserID, &member.Username, &member.DisplayName, &member.Description, &member.PublicKey, &member.Avatar,
			&member.IsRemote, &member.FederationInstanceURL, &member.RemoteUsername, &member.EncryptedConversationKey, &member.Role) == nil {
			members = append(members, member)
		}
	}
	httpx.JSON(w, http.StatusOK, members)
}

func (h *Handler) AddMember(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		UserID                   int64  `json:"user_id"`
		EncryptedConversationKey string `json:"encrypted_conversation_key"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	var ownerID int64
	var kind string
	if h.DB.QueryRow(`SELECT created_by,type FROM conversations WHERE id=?`, conversationID).Scan(&ownerID, &kind) != nil ||
		ownerID != auth.UserID(r) || kind != "group" {
		httpx.Error(w, http.StatusForbidden, "only the group owner can add members")
		return
	}
	if input.UserID <= 0 || len(input.EncryptedConversationKey) < 10 {
		httpx.Error(w, http.StatusBadRequest, "invalid member")
		return
	}
	var isRemote bool
	if h.DB.QueryRow(`SELECT is_remote FROM users WHERE id=?`, input.UserID).Scan(&isRemote) != nil {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	if isRemote {
		var existingRemote int
		_ = h.DB.QueryRow(`SELECT COUNT(*) FROM conversation_members cm JOIN users u ON u.id=cm.user_id
			WHERE cm.conversation_id=? AND u.is_remote=1`, conversationID).Scan(&existingRemote)
		if existingRemote > 0 {
			httpx.Error(w, http.StatusConflict, "a federated group currently supports one remote participant")
			return
		}
	}
	result, err := h.DB.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		SELECT ?,?,?, 'pending',? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)`,
		conversationID, input.UserID, input.EncryptedConversationKey, time.Now().UTC().Format(time.RFC3339Nano), input.UserID)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "member already exists")
		return
	}
	affected, _ := result.RowsAffected()
	if affected != 1 {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	h.notifyMembers(conversationID, "conversation_updated")
	if h.Federation != nil {
		h.Federation.QueueGroupMemberAdd(conversationID, input.UserID)
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	userID := auth.UserID(r)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE conversation_members SET role='member',created_at=? WHERE conversation_id=? AND user_id=? AND role='pending'
		AND EXISTS(SELECT 1 FROM conversations WHERE id=? AND type='group')`, now, conversationID, userID, conversationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "conversation update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	h.notifyMembers(conversationID, "conversation_updated")
	if h.Federation != nil {
		h.Federation.QueueGroupAccept(conversationID, userID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	memberID, err := httpx.PathID(r, "user_id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var ownerID int64
	var kind string
	if h.DB.QueryRow(`SELECT created_by,type FROM conversations WHERE id=?`, conversationID).Scan(&ownerID, &kind) != nil ||
		ownerID != auth.UserID(r) || kind != "group" || memberID == ownerID {
		httpx.Error(w, http.StatusForbidden, "member cannot be removed")
		return
	}
	result, err := h.DB.Exec(`DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?`, conversationID, memberID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "member removal failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "member not found")
		return
	}
	h.Hub.SendToUser(memberID, map[string]any{"type": "conversation_updated", "conversation_id": conversationID, "removed": true})
	h.notifyMembers(conversationID, "conversation_updated")
	if h.Federation != nil {
		h.Federation.QueueGroupMemberRemove(conversationID, memberID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		EncryptedTitle       string  `json:"encrypted_title"`
		EncryptedDescription *string `json:"encrypted_description"`
		EncryptedAvatar      *string `json:"encrypted_avatar"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if len(input.EncryptedTitle) < 10 || len(input.EncryptedTitle) > 4096 {
		httpx.Error(w, http.StatusBadRequest, "invalid group")
		return
	}
	if input.EncryptedDescription != nil && (len(*input.EncryptedDescription) < 10 || len(*input.EncryptedDescription) > 8192) {
		httpx.Error(w, http.StatusBadRequest, "invalid group")
		return
	}
	if input.EncryptedAvatar != nil && (len(*input.EncryptedAvatar) < 10 || len(*input.EncryptedAvatar) > 512<<10) {
		httpx.Error(w, http.StatusBadRequest, "invalid group")
		return
	}
	result, err := h.DB.Exec(`UPDATE conversations SET encrypted_title=?,encrypted_description=?,encrypted_avatar=?
		WHERE id=? AND type='group' AND created_by=?`,
		input.EncryptedTitle, input.EncryptedDescription, input.EncryptedAvatar, conversationID, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "conversation update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusForbidden, "only the group owner can edit the group")
		return
	}
	h.notifyMembers(conversationID, "conversation_updated")
	if h.Federation != nil {
		h.Federation.QueueGroupUpdate(conversationID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	userID := auth.UserID(r)
	var kind string
	var ownerID int64
	err = h.DB.QueryRow(`SELECT c.type,c.created_by FROM conversations c
		JOIN conversation_members cm ON cm.conversation_id=c.id
		WHERE c.id=? AND cm.user_id=?`, conversationID, userID).Scan(&kind, &ownerID)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	if kind == "group" && ownerID != userID {
		if h.Federation != nil {
			h.Federation.QueueGroupDelete(conversationID, userID)
		}
		if _, err := h.DB.Exec(`DELETE FROM conversation_members WHERE conversation_id=? AND user_id=?`, conversationID, userID); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "conversation deletion failed")
			return
		}
		if h.Hub != nil {
			h.Hub.SendToUser(userID, map[string]any{"type": "conversation_updated", "conversation_id": conversationID, "removed": true})
		}
		h.notifyMembers(conversationID, "conversation_updated")
		httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "action": "left"})
		return
	}
	if kind == "group" && h.Federation != nil {
		h.Federation.QueueGroupDelete(conversationID, userID)
	}
	rows, err := h.DB.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=?`, conversationID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "conversation deletion failed")
		return
	}
	var memberIDs []int64
	for rows.Next() {
		var memberID int64
		if rows.Scan(&memberID) == nil {
			memberIDs = append(memberIDs, memberID)
		}
	}
	rows.Close()
	if kind == "private" && len(memberIDs) == 2 {
		if _, err := h.DB.Exec(`DELETE FROM contacts WHERE (owner_id=? AND contact_user_id=?) OR (owner_id=? AND contact_user_id=?)`,
			memberIDs[0], memberIDs[1], memberIDs[1], memberIDs[0]); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "conversation deletion failed")
			return
		}
	}
	if _, err := h.DB.Exec(`DELETE FROM conversations WHERE id=?`, conversationID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "conversation deletion failed")
		return
	}
	if h.Hub != nil {
		for _, memberID := range memberIDs {
			h.Hub.SendToUser(memberID, map[string]any{
				"type": "conversation_updated", "conversation_id": conversationID, "deleted": true,
			})
			if kind == "private" {
				h.Hub.SendToUser(memberID, map[string]any{"type": "contact_updated"})
			}
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "action": "deleted"})
}

func (h *Handler) isMember(conversationID, userID int64) bool {
	var count int
	return h.DB.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=?`, conversationID, userID).Scan(&count) == nil && count == 1
}

func (h *Handler) hasAcceptedContact(ownerID, contactUserID int64) bool {
	var count int
	return h.DB.QueryRow(`SELECT COUNT(*) FROM contacts own
		JOIN contacts reciprocal ON reciprocal.owner_id=own.contact_user_id AND reciprocal.contact_user_id=own.owner_id AND reciprocal.status='accepted'
		WHERE own.owner_id=? AND own.contact_user_id=? AND own.status='accepted'`, ownerID, contactUserID).
		Scan(&count) == nil && count == 1
}

func (h *Handler) notifyMembers(conversationID int64, kind string) {
	if h.Hub == nil {
		return
	}
	rows, err := h.DB.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=?`, conversationID)
	if err != nil {
		return
	}
	defer rows.Close()
	payload, _ := json.Marshal(map[string]any{"type": kind, "conversation_id": conversationID})
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			h.Hub.SendToUser(id, payload)
		}
	}
}
