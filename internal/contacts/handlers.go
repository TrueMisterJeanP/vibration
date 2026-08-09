package contacts

import (
	"database/sql"
	"errors"
	"net/http"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/carnet"
	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/userdiscovery"
)

type Broadcaster interface {
	SendToUser(userID int64, event any) bool
}

type Handler struct {
	DB  *sql.DB
	Hub Broadcaster
}

type Contact struct {
	ID               int64   `json:"id"`
	ContactUserID    int64   `json:"contact_user_id"`
	Username         string  `json:"username"`
	DisplayName      string  `json:"display_name"`
	Description      string  `json:"description"`
	PublicKey        string  `json:"public_key"`
	SigningPublicKey string  `json:"signing_public_key"`
	SigningKeyID     string  `json:"signing_key_id"`
	Avatar           *string `json:"avatar"`
	EncryptedLabel   *string `json:"encrypted_label"`
	Status           string  `json:"status"`
	Direction        string  `json:"direction"`
	CreatedAt        string  `json:"created_at"`
}

type CarnetEntry struct {
	ID                     int64   `json:"id"`
	ContactUserID          int64   `json:"contact_user_id"`
	Username               string  `json:"username"`
	DisplayName            string  `json:"display_name"`
	Description            string  `json:"description"`
	Avatar                 *string `json:"avatar"`
	IsRemote               bool    `json:"is_remote"`
	RemoteInstanceID       *int64  `json:"remote_instance_id"`
	RemoteUsername         *string `json:"remote_username"`
	FederationInstanceURL  *string `json:"federation_instance_url"`
	Active                 bool    `json:"active"`
	HasPrivateConversation bool    `json:"has_private_conversation"`
	CanResume              bool    `json:"can_resume"`
}

func (h *Handler) CarnetList(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r)
	if err := carnet.Sync(h.DB, userID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "carnet synchronization failed")
		return
	}
	rows, err := h.DB.Query(`SELECT b.id,b.contact_user_id,COALESCE(u.remote_username,u.username),u.display_name,u.description,u.avatar,
		u.is_remote,u.remote_instance_id,u.remote_username,fi.base_url,
		(SELECT COUNT(*) FROM conversation_members mine
			JOIN conversations c ON c.id=mine.conversation_id AND c.type IN ('private','group')
			JOIN conversation_members peer ON peer.conversation_id=mine.conversation_id
			WHERE mine.user_id=? AND mine.role<>'pending' AND peer.user_id=b.contact_user_id AND peer.role<>'pending'),
		(SELECT COUNT(*) FROM conversation_members mine
			JOIN conversations c ON c.id=mine.conversation_id AND c.type='private'
			JOIN conversation_members peer ON peer.conversation_id=mine.conversation_id
			WHERE mine.user_id=? AND mine.role<>'pending' AND peer.user_id=b.contact_user_id AND peer.role<>'pending')
		FROM carnet_entries b JOIN users u ON u.id=b.contact_user_id
		LEFT JOIN federated_instances fi ON fi.id=u.remote_instance_id
		WHERE b.owner_id=?
		ORDER BY LOWER(COALESCE(u.remote_username,u.username)),LOWER(u.display_name)`, userID, userID, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "carnet lookup failed")
		return
	}
	defer rows.Close()
	entries := make([]CarnetEntry, 0)
	for rows.Next() {
		var entry CarnetEntry
		var remoteInstanceID sql.NullInt64
		var remoteUsername, instanceURL sql.NullString
		var activeCount, privateConversationCount int
		if err := rows.Scan(&entry.ID, &entry.ContactUserID, &entry.Username, &entry.DisplayName, &entry.Description, &entry.Avatar,
			&entry.IsRemote, &remoteInstanceID, &remoteUsername, &instanceURL, &activeCount, &privateConversationCount); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "carnet lookup failed")
			return
		}
		if remoteInstanceID.Valid {
			value := remoteInstanceID.Int64
			entry.RemoteInstanceID = &value
		}
		if remoteUsername.Valid {
			value := remoteUsername.String
			entry.RemoteUsername = &value
		}
		if instanceURL.Valid {
			value := instanceURL.String
			entry.FederationInstanceURL = &value
		}
		entry.Active = activeCount > 0
		entry.HasPrivateConversation = privateConversationCount > 0
		entry.CanResume = !entry.IsRemote || entry.RemoteInstanceID != nil
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "carnet lookup failed")
		return
	}
	httpx.JSON(w, http.StatusOK, entries)
}

func (h *Handler) CarnetDelete(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	userID := auth.UserID(r)
	var contactID int64
	if err := h.DB.QueryRow(`SELECT contact_user_id FROM carnet_entries WHERE id=? AND owner_id=?`, id, userID).Scan(&contactID); err != nil {
		httpx.Error(w, http.StatusNotFound, "carnet entry not found")
		return
	}
	active, err := carnet.Active(h.DB, userID, contactID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "carnet status lookup failed")
		return
	}
	if active {
		httpx.Error(w, http.StatusConflict, "active carnet entry cannot be deleted")
		return
	}
	result, err := h.DB.Exec(`DELETE FROM carnet_entries WHERE id=? AND owner_id=?`, id, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "carnet deletion failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "carnet entry not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) CarnetDeleteAll(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r)
	result, err := h.DB.Exec(`DELETE FROM carnet_entries
		WHERE owner_id=? AND NOT EXISTS(
			SELECT 1 FROM conversation_members mine
			JOIN conversations c ON c.id=mine.conversation_id AND c.type IN ('private','group')
			JOIN conversation_members peer ON peer.conversation_id=mine.conversation_id
			WHERE mine.user_id=? AND mine.role<>'pending' AND peer.user_id=carnet_entries.contact_user_id AND peer.role<>'pending')`, userID, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "carnet deletion failed")
		return
	}
	deleted, _ := result.RowsAffected()
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	userID := auth.UserID(r)
	h.ensureFederatedContacts(userID)
	rows, err := h.DB.Query(`SELECT id,contact_user_id,username,display_name,description,public_key,signing_public_key,signing_key_id,avatar,encrypted_label,status,direction,created_at
		FROM (
			SELECT c.id AS id,c.contact_user_id AS contact_user_id,COALESCE(u.remote_username,u.username) AS username,u.display_name AS display_name,
				u.description AS description,u.public_key AS public_key,u.signing_public_key AS signing_public_key,u.signing_key_id AS signing_key_id,u.avatar AS avatar,c.encrypted_label AS encrypted_label,
				c.status AS status,'outgoing' AS direction,c.created_at AS created_at
			FROM contacts c JOIN users u ON u.id=c.contact_user_id WHERE c.owner_id=?
			UNION ALL
			SELECT c.id AS id,c.owner_id AS contact_user_id,COALESCE(u.remote_username,u.username) AS username,u.display_name AS display_name,
				u.description AS description,u.public_key AS public_key,u.signing_public_key AS signing_public_key,u.signing_key_id AS signing_key_id,u.avatar AS avatar,c.encrypted_label AS encrypted_label,
				c.status AS status,'incoming' AS direction,c.created_at AS created_at
			FROM contacts c JOIN users u ON u.id=c.owner_id WHERE c.contact_user_id=? AND c.status='pending'
		) contact_rows
		ORDER BY username`, userID, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "contacts lookup failed")
		return
	}
	defer rows.Close()
	contacts := make([]Contact, 0)
	for rows.Next() {
		var contact Contact
		if rows.Scan(&contact.ID, &contact.ContactUserID, &contact.Username, &contact.DisplayName, &contact.Description, &contact.PublicKey,
			&contact.SigningPublicKey, &contact.SigningKeyID, &contact.Avatar, &contact.EncryptedLabel, &contact.Status, &contact.Direction, &contact.CreatedAt) == nil {
			contacts = append(contacts, contact)
		}
	}
	httpx.JSON(w, http.StatusOK, contacts)
}

func (h *Handler) ensureFederatedContacts(userID int64) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	rows, err := h.DB.Query(`SELECT local_user_id,remote_user_id FROM federated_conversations WHERE local_user_id=?`, userID)
	if err != nil {
		return
	}
	pairs := [][2]int64{}
	for rows.Next() {
		var localID, remoteID int64
		if rows.Scan(&localID, &remoteID) == nil {
			pairs = append(pairs, [2]int64{localID, remoteID})
		}
	}
	rows.Close()
	for _, pair := range pairs {
		for _, direction := range [][2]int64{pair, {pair[1], pair[0]}} {
			_, _ = h.DB.Exec(`INSERT INTO contacts(owner_id,contact_user_id,status,created_at)
				SELECT ?,?,'accepted',? WHERE NOT EXISTS(SELECT 1 FROM contacts WHERE owner_id=? AND contact_user_id=?)`,
				direction[0], direction[1], now, direction[0], direction[1])
		}
	}
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	var input struct {
		UserID         int64   `json:"user_id"`
		EncryptedLabel *string `json:"encrypted_label"`
		DiscoveryCode  string  `json:"discovery_code"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	ownerID := auth.UserID(r)
	if input.UserID <= 0 || input.UserID == ownerID {
		httpx.Error(w, http.StatusBadRequest, "invalid contact")
		return
	}
	allowed, err := userdiscovery.CanInitiate(h.DB, ownerID, input.UserID, input.DiscoveryCode)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "user lookup failed")
		return
	}
	if !allowed {
		httpx.Error(w, http.StatusNotFound, "user not found")
		return
	}
	var incomingID int64
	err = h.DB.QueryRow(`SELECT id FROM contacts WHERE owner_id=? AND contact_user_id=? AND status='pending'`, input.UserID, ownerID).Scan(&incomingID)
	if err == nil {
		conversationID, ok := h.accept(incomingID, ownerID)
		if !ok {
			httpx.Error(w, http.StatusInternalServerError, "contact acceptance failed")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"id": incomingID, "status": "accepted", "conversation_id": conversationID})
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`INSERT INTO contacts(owner_id,contact_user_id,encrypted_label,status,created_at) VALUES(?,?,?,?,?)`,
		ownerID, input.UserID, input.EncryptedLabel, "pending", now)
	if err != nil {
		httpx.Error(w, http.StatusConflict, "contact already exists")
		return
	}
	id, _ := result.LastInsertId()
	h.notify(ownerID, input.UserID)
	httpx.JSON(w, http.StatusCreated, map[string]any{"id": id, "status": "pending"})
}

func (h *Handler) Accept(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	conversationID, ok := h.accept(id, auth.UserID(r))
	if !ok {
		httpx.Error(w, http.StatusNotFound, "contact request not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "conversation_id": conversationID})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	userID := auth.UserID(r)
	var otherID int64
	if err := h.DB.QueryRow(`SELECT CASE WHEN owner_id=? THEN contact_user_id ELSE owner_id END FROM contacts
		WHERE id=? AND (owner_id=? OR contact_user_id=?)`, userID, id, userID, userID).Scan(&otherID); err != nil {
		httpx.Error(w, http.StatusNotFound, "contact not found")
		return
	}
	conversationIDs, err := h.deleteRelation(userID, otherID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	h.notify(userID, otherID)
	for _, conversationID := range conversationIDs {
		h.notifyConversationDeleted(conversationID, userID, otherID)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) deleteRelation(userID, otherID int64) ([]int64, error) {
	tx, err := h.DB.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT c.id FROM conversations c
		JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=?
		JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=?
		WHERE c.type='private' AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id=c.id)=2`, userID, otherID)
	if err != nil {
		return nil, err
	}
	var conversationIDs []int64
	for rows.Next() {
		var conversationID int64
		if rows.Scan(&conversationID) == nil {
			conversationIDs = append(conversationIDs, conversationID)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if _, err := tx.Exec(`DELETE FROM contacts WHERE (owner_id=? AND contact_user_id=?) OR (owner_id=? AND contact_user_id=?)`,
		userID, otherID, otherID, userID); err != nil {
		return nil, err
	}
	for _, conversationID := range conversationIDs {
		if _, err := tx.Exec(`DELETE FROM conversations WHERE id=?`, conversationID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if len(conversationIDs) > 0 {
		if err := carnet.Ensure(h.DB, userID, otherID); err != nil {
			return nil, err
		}
		if err := carnet.Ensure(h.DB, otherID, userID); err != nil {
			return nil, err
		}
	}
	return conversationIDs, nil
}

func (h *Handler) accept(id, userID int64) (int64, bool) {
	tx, err := h.DB.Begin()
	if err != nil {
		return 0, false
	}
	defer tx.Rollback()
	var requesterID int64
	if err := tx.QueryRow(`SELECT owner_id FROM contacts WHERE id=? AND contact_user_id=? AND status='pending'`, id, userID).Scan(&requesterID); err != nil {
		return 0, false
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := tx.Exec(`UPDATE contacts SET status='accepted' WHERE id=?`, id); err != nil {
		return 0, false
	}
	result, err := tx.Exec(`UPDATE contacts SET status='accepted' WHERE owner_id=? AND contact_user_id=?`, userID, requesterID)
	if err != nil {
		return 0, false
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		if _, err := tx.Exec(`INSERT INTO contacts(owner_id,contact_user_id,status,created_at) VALUES(?,?,?,?)`,
			userID, requesterID, "accepted", now); err != nil {
			return 0, false
		}
	}
	conversationID, err := ensurePrivateConversation(tx, requesterID, userID, now)
	if err != nil {
		return 0, false
	}
	if tx.Commit() != nil {
		return 0, false
	}
	_ = carnet.Ensure(h.DB, requesterID, userID)
	_ = carnet.Ensure(h.DB, userID, requesterID)
	h.notify(userID, requesterID)
	return conversationID, true
}

func ensurePrivateConversation(tx *sql.Tx, requesterID, accepterID int64, now string) (int64, error) {
	var existing int64
	err := tx.QueryRow(`SELECT c.id FROM conversations c
		JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=?
		JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=?
		WHERE c.type='private' AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id=c.id)=2 LIMIT 1`,
		requesterID, accepterID).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	result, err := tx.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES(?,?,?)`, "private", requesterID, now)
	if err != nil {
		return 0, err
	}
	conversationID, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, member := range []struct {
		userID int64
		role   string
	}{
		{userID: requesterID, role: "owner"},
		{userID: accepterID, role: "member"},
	} {
		if _, err := tx.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
			VALUES(?,?,?,?,?)`, conversationID, member.userID, "ecdh-v1", member.role, now); err != nil {
			return 0, err
		}
	}
	return conversationID, nil
}

func (h *Handler) notify(userIDs ...int64) {
	if h.Hub == nil {
		return
	}
	for _, userID := range userIDs {
		if userID > 0 {
			h.Hub.SendToUser(userID, map[string]any{"type": "contact_updated"})
		}
	}
}

func (h *Handler) notifyConversationDeleted(conversationID int64, userIDs ...int64) {
	if h.Hub == nil {
		return
	}
	for _, userID := range userIDs {
		if userID > 0 {
			h.Hub.SendToUser(userID, map[string]any{"type": "conversation_updated", "conversation_id": conversationID, "deleted": true})
		}
	}
}
