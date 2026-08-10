package messages

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/groupkeys"
	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/messageauth"
)

type Broadcaster interface {
	SendToUser(userID int64, event any) bool
}

type PushSender interface {
	NotifyUser(userID int64)
	NotifyUserWithContent(userID int64, title, body, url, tag string)
}

type FederationRouter interface {
	QueueMessage(message Message)
	QueueMessageUpdate(messageID int64, encryptedContent, iv, updatedAt string)
	QueueMessageDelete(conversationID, messageID, userID int64)
	QueueReaction(messageID, userID int64, emoji string, active bool, createdAt string)
	QueuePin(messageID, userID int64, pinned bool, updatedAt string)
	QueueReceipt(messageID, userID int64, status, updatedAt string)
	QueueFile(messageID int64)
	RelayRealtime(conversationID, senderID int64, event map[string]any) bool
	RelayPresence(userID int64, online bool)
	QueueGroupCreate(conversationID int64)
	QueueGroupAccept(conversationID, userID int64)
	QueueGroupUpdate(conversationID int64)
	QueueGroupDelete(conversationID, userID int64)
	QueueGroupMemberAdd(conversationID, memberID int64)
	QueueGroupMemberRemove(conversationID, memberID int64)
	QueueGroupRotation(conversationID int64, removedMemberIDs, addedMemberIDs []int64)
	QueuePollUpdate(messageID int64, encryptedContent, iv string, optionCount int, expiresAt *string)
	QueuePollDelete(conversationID, messageID, userID int64)
	QueuePollVote(messageID, userID int64, optionPosition int, votedAt string)
	QueueEventUpdate(messageID int64, encryptedContent, iv, startsAt, endsAt string)
	QueueEventDelete(conversationID, messageID, userID int64)
}

type Handler struct {
	DB         *sql.DB
	Hub        Broadcaster
	Push       PushSender
	Federation FederationRouter
	// ExpirySweepInterval overrides how often expired messages are physically
	// deleted. Zero uses expirySweepInterval.
	ExpirySweepInterval time.Duration

	sweepOnce sync.Once
	sweep     *expirySweeper
}

type Message struct {
	ID                      int64      `json:"id"`
	ConversationID          int64      `json:"conversation_id"`
	SenderID                int64      `json:"sender_id"`
	SenderUsername          string     `json:"sender_username"`
	SenderAvatar            *string    `json:"sender_avatar"`
	EncryptedContent        *string    `json:"encrypted_content"`
	IV                      string     `json:"iv"`
	KeyEpoch                int64      `json:"key_epoch"`
	ReplyTo                 *int64     `json:"reply_to"`
	ExpiresAt               *string    `json:"expires_at"`
	IsPinned                bool       `json:"is_pinned"`
	PinnedBy                *int64     `json:"pinned_by"`
	PinnedAt                *string    `json:"pinned_at"`
	CreatedAt               string     `json:"created_at"`
	UpdatedAt               *string    `json:"updated_at"`
	ClientMessageID         *string    `json:"client_message_id,omitempty"`
	SignatureConversationID string     `json:"signature_conversation_id,omitempty"`
	SignatureSenderID       string     `json:"signature_sender_id,omitempty"`
	SignatureReplyTo        string     `json:"signature_reply_to,omitempty"`
	SignatureVersion        int        `json:"signature_version"`
	SigningKeyID            *string    `json:"signing_key_id,omitempty"`
	Signature               *string    `json:"signature,omitempty"`
	MessageKind             string     `json:"message_kind"`
	Revision                int64      `json:"revision"`
	File                    *File      `json:"file,omitempty"`
	Poll                    *Poll      `json:"poll,omitempty"`
	Event                   *Event     `json:"event,omitempty"`
	Reactions               []Reaction `json:"reactions,omitempty"`
	Status                  string     `json:"status"`
	IsReported              bool       `json:"is_reported"`
}

type Reaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Mine  bool   `json:"mine"`
}

type Poll struct {
	Options    []PollOption `json:"options"`
	TotalVotes int          `json:"total_votes"`
	HasVoted   bool         `json:"has_voted"`
	ExpiresAt  *string      `json:"expires_at"`
	Closed     bool         `json:"closed"`
}

type PollOption struct {
	ID        int64 `json:"id"`
	Position  int   `json:"position"`
	VoteCount int   `json:"vote_count"`
	Mine      bool  `json:"mine"`
}

type Event struct {
	StartsAt string `json:"starts_at"`
	EndsAt   string `json:"ends_at"`
}

var validMessageReportReasons = map[string]struct{}{
	"harassment":      {},
	"threats":         {},
	"hate":            {},
	"sexual_content":  {},
	"spam_scam":       {},
	"personal_data":   {},
	"illegal_content": {},
}

type File struct {
	ID               int64  `json:"id"`
	EncryptedName    string `json:"encrypted_name"`
	EncryptedMIME    string `json:"encrypted_mime"`
	IV               string `json:"iv"`
	Size             int64  `json:"size"`
	HasPreview       bool   `json:"has_preview"`
	PreviewSize      int64  `json:"preview_size,omitempty"`
	CiphertextSHA256 string `json:"ciphertext_sha256,omitempty"`
	PreviewSHA256    string `json:"preview_sha256,omitempty"`
}

func (h *Handler) List(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	if err != nil || !h.isMember(conversationID, auth.UserID(r)) {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	if before <= 0 {
		before = 1<<63 - 1
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	comparison := "<"
	boundary := before
	order := "DESC"
	if after > 0 {
		comparison = ">"
		boundary = after
		order = "ASC"
	}
	h.deleteExpired(conversationID)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	query := `SELECT m.id,m.conversation_id,m.sender_id,COALESCE(u.remote_username,u.username),u.avatar,m.encrypted_content,m.iv,m.key_epoch,m.reply_to,m.expires_at,mp.user_id,mp.created_at,m.created_at,m.updated_at,
		m.client_message_id,COALESCE(m.signature_conversation_id,''),COALESCE(m.signature_sender_id,''),COALESCE(m.signature_reply_to,''),m.signature_version,m.signing_key_id,m.signature,m.message_kind,m.revision,
		f.id,f.encrypted_name,f.encrypted_mime,f.iv,f.size,f.preview_size,f.ciphertext_sha256,f.preview_sha256,
		CASE
			WHEN NOT EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id=m.id AND mr.user_id<>m.sender_id AND mr.status<>'read') THEN 'read'
			WHEN NOT EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id=m.id AND mr.user_id<>m.sender_id AND mr.status='sent') THEN 'delivered'
			ELSE 'sent'
		END,own_report.message_id IS NOT NULL
		FROM messages m JOIN users u ON u.id=m.sender_id LEFT JOIN files f ON f.message_id=m.id
		LEFT JOIN message_pins mp ON mp.message_id=m.id AND mp.user_id=?
		LEFT JOIN message_reports own_report ON own_report.message_id=m.id AND own_report.reporter_id=?
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? AND cm.role<>'pending'
		WHERE m.conversation_id=? AND m.id` + comparison + `? AND m.created_at>=cm.created_at AND (m.expires_at IS NULL OR m.expires_at>?) ORDER BY m.id ` + order + ` LIMIT ?`
	rows, err := h.DB.Query(query, auth.UserID(r), auth.UserID(r), auth.UserID(r), conversationID, boundary, now, limit)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message lookup failed")
		return
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var item Message
		var fileID, pinnedBy sql.NullInt64
		var fileName, fileMIME, fileIV, fileDigest, previewDigest, expiresAt, pinnedAt sql.NullString
		var fileSize, previewSize sql.NullInt64
		if rows.Scan(&item.ID, &item.ConversationID, &item.SenderID, &item.SenderUsername, &item.SenderAvatar, &item.EncryptedContent, &item.IV, &item.KeyEpoch,
			&item.ReplyTo, &expiresAt, &pinnedBy, &pinnedAt, &item.CreatedAt, &item.UpdatedAt, &item.ClientMessageID, &item.SignatureConversationID, &item.SignatureSenderID, &item.SignatureReplyTo, &item.SignatureVersion,
			&item.SigningKeyID, &item.Signature, &item.MessageKind, &item.Revision, &fileID, &fileName, &fileMIME, &fileIV, &fileSize, &previewSize,
			&fileDigest, &previewDigest, &item.Status, &item.IsReported) == nil {
			if expiresAt.Valid {
				item.ExpiresAt = &expiresAt.String
			}
			if pinnedBy.Valid && pinnedAt.Valid {
				item.IsPinned = true
				item.PinnedBy = &pinnedBy.Int64
				item.PinnedAt = &pinnedAt.String
			}
			if fileID.Valid {
				item.File = &File{ID: fileID.Int64, EncryptedName: fileName.String, EncryptedMIME: fileMIME.String, IV: fileIV.String, Size: fileSize.Int64,
					HasPreview: previewSize.Valid && previewSize.Int64 > 0, PreviewSize: previewSize.Int64, CiphertextSHA256: fileDigest.String, PreviewSHA256: previewDigest.String}
			}
			result = append(result, item)
		}
	}
	h.attachReactions(result, auth.UserID(r))
	h.attachPolls(result, auth.UserID(r))
	h.attachEvents(result)
	if after <= 0 {
		for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
			result[left], result[right] = result[right], result[left]
		}
	}
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) ListPinned(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	userID := auth.UserID(r)
	if !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	h.deleteExpired(conversationID)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	rows, err := h.DB.Query(`SELECT m.id,m.conversation_id,m.sender_id,COALESCE(u.remote_username,u.username),u.avatar,m.encrypted_content,m.iv,m.key_epoch,m.reply_to,m.expires_at,mp.user_id,mp.created_at,m.created_at,m.updated_at,
		m.client_message_id,COALESCE(m.signature_conversation_id,''),COALESCE(m.signature_sender_id,''),COALESCE(m.signature_reply_to,''),m.signature_version,m.signing_key_id,m.signature,m.message_kind,m.revision,
		f.id,f.encrypted_name,f.encrypted_mime,f.iv,f.size,f.preview_size,f.ciphertext_sha256,f.preview_sha256,
		CASE
			WHEN NOT EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id=m.id AND mr.user_id<>m.sender_id AND mr.status<>'read') THEN 'read'
			WHEN NOT EXISTS(SELECT 1 FROM message_receipts mr WHERE mr.message_id=m.id AND mr.user_id<>m.sender_id AND mr.status='sent') THEN 'delivered'
			ELSE 'sent'
		END,own_report.message_id IS NOT NULL
		FROM message_pins mp JOIN messages m ON m.id=mp.message_id
		JOIN users u ON u.id=m.sender_id LEFT JOIN files f ON f.message_id=m.id
		LEFT JOIN message_reports own_report ON own_report.message_id=m.id AND own_report.reporter_id=?
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=mp.user_id AND cm.role<>'pending'
		WHERE mp.user_id=? AND m.conversation_id=? AND m.created_at>=cm.created_at
		AND (m.expires_at IS NULL OR m.expires_at>?)
		ORDER BY mp.created_at DESC`, userID, userID, conversationID, now)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message lookup failed")
		return
	}
	defer rows.Close()
	result := make([]Message, 0)
	for rows.Next() {
		var item Message
		var fileID, pinnedBy sql.NullInt64
		var fileName, fileMIME, fileIV, fileDigest, previewDigest, expiresAt, pinnedAt sql.NullString
		var fileSize, previewSize sql.NullInt64
		if rows.Scan(&item.ID, &item.ConversationID, &item.SenderID, &item.SenderUsername, &item.SenderAvatar, &item.EncryptedContent, &item.IV, &item.KeyEpoch,
			&item.ReplyTo, &expiresAt, &pinnedBy, &pinnedAt, &item.CreatedAt, &item.UpdatedAt, &item.ClientMessageID, &item.SignatureConversationID, &item.SignatureSenderID, &item.SignatureReplyTo, &item.SignatureVersion,
			&item.SigningKeyID, &item.Signature, &item.MessageKind, &item.Revision, &fileID, &fileName, &fileMIME, &fileIV, &fileSize, &previewSize,
			&fileDigest, &previewDigest, &item.Status, &item.IsReported) == nil {
			if expiresAt.Valid {
				item.ExpiresAt = &expiresAt.String
			}
			item.IsPinned = true
			item.PinnedBy = &pinnedBy.Int64
			item.PinnedAt = &pinnedAt.String
			if fileID.Valid {
				item.File = &File{ID: fileID.Int64, EncryptedName: fileName.String, EncryptedMIME: fileMIME.String, IV: fileIV.String, Size: fileSize.Int64,
					HasPreview: previewSize.Valid && previewSize.Int64 > 0, PreviewSize: previewSize.Int64, CiphertextSHA256: fileDigest.String, PreviewSHA256: previewDigest.String}
			}
			result = append(result, item)
		}
	}
	h.attachReactions(result, userID)
	h.attachPolls(result, userID)
	h.attachEvents(result)
	httpx.JSON(w, http.StatusOK, result)
}

func (h *Handler) Create(w http.ResponseWriter, r *http.Request) {
	conversationID, err := httpx.PathID(r, "id")
	userID := auth.UserID(r)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "conversation not found")
		return
	}
	var input struct {
		EncryptedContent string `json:"encrypted_content"`
		IV               string `json:"iv"`
		ReplyTo          *int64 `json:"reply_to"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
		KeyEpoch         int64  `json:"key_epoch"`
		messageauth.Input
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if len(input.EncryptedContent) < 1 || len(input.EncryptedContent) > 1<<20 || len(input.IV) < 8 || len(input.IV) > 128 {
		httpx.Error(w, http.StatusBadRequest, "invalid encrypted message")
		return
	}
	expiresAt, validExpiry := expiryTime(input.ExpiresInSeconds)
	if !validExpiry {
		httpx.Error(w, http.StatusBadRequest, "invalid message expiration")
		return
	}
	message, err := h.insert(conversationID, userID, &input.EncryptedContent, input.IV, input.KeyEpoch, input.ReplyTo, expiresAt, nil, 0, nil, "text", input.Input)
	if err != nil {
		h.writeCreateError(w, err)
		return
	}
	h.broadcast(message)
	if h.Federation != nil {
		h.Federation.QueueMessage(message)
	}
	httpx.JSON(w, http.StatusCreated, message)
}

func (h *Handler) insert(conversationID, userID int64, content *string, iv string, keyEpoch int64, replyTo *int64, expiresAt, pollExpiresAt *string, pollOptionCount int, event *Event, kind string, signatureInput messageauth.Input) (Message, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := h.DB.Begin()
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	keyEpoch, err = groupkeys.ValidateSend(tx, conversationID, userID, keyEpoch)
	if err != nil {
		return Message{}, err
	}
	payload := messageauth.NewPayload(kind, conversationID, userID, signatureInput, keyEpoch, replyTo, valueOrEmpty(content), iv)
	payload.OptionCount = pollOptionCount
	if event != nil {
		payload.StartsAt, payload.EndsAt = event.StartsAt, event.EndsAt
	}
	if err := h.verifyMessageSignature(tx, userID, signatureInput, payload); err != nil {
		return Message{}, err
	}
	result, err := tx.Exec(`INSERT INTO messages(conversation_id,sender_id,encrypted_content,iv,key_epoch,reply_to,expires_at,poll_expires_at,created_at,
		client_message_id,signature_conversation_id,signature_sender_id,signature_reply_to,signature_version,signing_key_id,signature,message_kind,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		conversationID, userID, content, iv, keyEpoch, replyTo, expiresAt, pollExpiresAt, now, signatureInput.ClientMessageID,
		payload.ConversationID, payload.SenderID, payload.ReplyTo, signatureInput.SignatureVersion, signatureInput.SigningKeyID, signatureInput.Signature, kind, signatureInput.Revision)
	if err != nil {
		return Message{}, err
	}
	id, _ := result.LastInsertId()
	rows, err := tx.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND role<>'pending'`, conversationID)
	if err != nil {
		return Message{}, err
	}
	var members []int64
	for rows.Next() {
		var memberID int64
		if rows.Scan(&memberID) == nil {
			members = append(members, memberID)
		}
	}
	rows.Close()
	for _, memberID := range members {
		status := "sent"
		if memberID == userID {
			status = "read"
		}
		if _, err := tx.Exec(`INSERT INTO message_receipts(message_id,user_id,status,created_at) VALUES(?,?,?,?)`, id, memberID, status, now); err != nil {
			return Message{}, err
		}
	}
	poll := (*Poll)(nil)
	if pollOptionCount > 0 {
		poll = &Poll{Options: make([]PollOption, 0, pollOptionCount), ExpiresAt: pollExpiresAt}
		for position := 0; position < pollOptionCount; position++ {
			if _, err := tx.Exec(`INSERT INTO poll_options(message_id,position) VALUES(?,?)`, id, position); err != nil {
				return Message{}, err
			}
		}
		optionRows, err := tx.Query(`SELECT id,position FROM poll_options WHERE message_id=? ORDER BY position`, id)
		if err != nil {
			return Message{}, err
		}
		for optionRows.Next() {
			var option PollOption
			if optionRows.Scan(&option.ID, &option.Position) == nil {
				poll.Options = append(poll.Options, option)
			}
		}
		if err := optionRows.Close(); err != nil {
			return Message{}, err
		}
	}
	if event != nil {
		if _, err := tx.Exec(`INSERT INTO message_events(message_id,starts_at,ends_at) VALUES(?,?,?)`, id, event.StartsAt, event.EndsAt); err != nil {
			return Message{}, err
		}
	}
	var username string
	var avatar *string
	if err := tx.QueryRow(`SELECT COALESCE(remote_username,username),avatar FROM users WHERE id=?`, userID).Scan(&username, &avatar); err != nil {
		return Message{}, err
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return Message{ID: id, ConversationID: conversationID, SenderID: userID, SenderUsername: username,
		SenderAvatar: avatar, EncryptedContent: content, IV: iv, KeyEpoch: keyEpoch, ReplyTo: replyTo, ExpiresAt: expiresAt, CreatedAt: now,
		ClientMessageID: &signatureInput.ClientMessageID, SignatureVersion: signatureInput.SignatureVersion, SigningKeyID: &signatureInput.SigningKeyID,
		SignatureConversationID: payload.ConversationID, SignatureSenderID: payload.SenderID, SignatureReplyTo: payload.ReplyTo, Signature: &signatureInput.Signature,
		MessageKind: kind, Revision: signatureInput.Revision, Poll: poll, Event: event, Status: "sent"}, nil
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

type queryRower interface {
	QueryRow(query string, args ...any) *sql.Row
}

func (h *Handler) verifyMessageSignature(query queryRower, userID int64, input messageauth.Input, payload messageauth.Payload) error {
	var publicKey string
	if err := query.QueryRow(`SELECT public_key FROM user_signing_keys WHERE user_id=? AND key_id=? AND revoked_at IS NULL`, userID, input.SigningKeyID).Scan(&publicKey); err != nil {
		return err
	}
	return messageauth.Verify(publicKey, input, payload)
}

func validNextSignature(oldClientID sql.NullString, oldRevision int64, input messageauth.Input) bool {
	if !oldClientID.Valid {
		return input.Revision == 1
	}
	return input.ClientMessageID == oldClientID.String && input.Revision == oldRevision+1
}

func (h *Handler) writeCreateError(w http.ResponseWriter, err error) {
	switch err {
	case groupkeys.ErrNotMember:
		httpx.Error(w, http.StatusNotFound, err.Error())
	case groupkeys.ErrRotationRequired, groupkeys.ErrStaleEpoch:
		httpx.Error(w, http.StatusConflict, err.Error())
	default:
		if strings.Contains(err.Error(), "signature") || strings.Contains(err.Error(), "signing key") || err == sql.ErrNoRows {
			httpx.Error(w, http.StatusBadRequest, "invalid message signature")
			return
		}
		httpx.Error(w, http.StatusInternalServerError, "message creation failed")
	}
}

func (h *Handler) Read(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	userID := auth.UserID(r)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var conversationID, senderID int64
	if err := h.DB.QueryRow(`SELECT conversation_id,sender_id FROM messages WHERE id=?`, messageID).Scan(&conversationID, &senderID); err != nil ||
		!h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	result, err := h.DB.Exec(`UPDATE message_receipts SET status='read',created_at=? WHERE message_id=? AND user_id=?`, now, messageID, userID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "receipt update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if h.Hub != nil {
		h.Hub.SendToUser(senderID, map[string]any{"type": "message_read", "message_id": messageID, "conversation_id": conversationID, "user_id": userID})
	}
	if h.Federation != nil {
		h.Federation.QueueReceipt(messageID, userID, "read", now)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) Update(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		EncryptedContent string `json:"encrypted_content"`
		IV               string `json:"iv"`
		messageauth.Input
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if len(input.EncryptedContent) < 1 || len(input.EncryptedContent) > 1<<20 || len(input.IV) < 8 || len(input.IV) > 128 {
		httpx.Error(w, http.StatusBadRequest, "invalid encrypted message")
		return
	}
	var conversationID, keyEpoch, oldRevision int64
	var replyTo *int64
	var oldClientID sql.NullString
	if err := h.DB.QueryRow(`SELECT conversation_id,key_epoch,reply_to,client_message_id,revision FROM messages WHERE id=? AND sender_id=?`, messageID, auth.UserID(r)).
		Scan(&conversationID, &keyEpoch, &replyTo, &oldClientID, &oldRevision); err != nil {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if !h.isMember(conversationID, auth.UserID(r)) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	expectedRevision := int64(1)
	if oldClientID.Valid {
		expectedRevision = oldRevision + 1
		if input.ClientMessageID != oldClientID.String {
			httpx.Error(w, http.StatusBadRequest, "invalid message signature")
			return
		}
	}
	if input.Revision != expectedRevision {
		httpx.Error(w, http.StatusBadRequest, "invalid message signature")
		return
	}
	payload := messageauth.NewPayload("text", conversationID, auth.UserID(r), input.Input, keyEpoch, replyTo, input.EncryptedContent, input.IV)
	if err := h.verifyMessageSignature(h.DB, auth.UserID(r), input.Input, payload); err != nil {
		httpx.Error(w, http.StatusBadRequest, "invalid message signature")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := h.DB.Exec(`UPDATE messages SET encrypted_content=?,iv=?,updated_at=?,client_message_id=?,signature_version=?,signing_key_id=?,signature=?,message_kind='text',revision=?
		WHERE id=? AND sender_id=?
		AND NOT EXISTS(SELECT 1 FROM files WHERE message_id=messages.id)
		AND NOT EXISTS(SELECT 1 FROM poll_options WHERE message_id=messages.id)
		AND NOT EXISTS(SELECT 1 FROM message_events WHERE message_id=messages.id)`,
		input.EncryptedContent, input.IV, now, input.ClientMessageID, input.SignatureVersion, input.SigningKeyID, input.Signature, input.Revision, messageID, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message update failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "conversation_updated", "conversation_id": conversationID, "updated_message_id": messageID,
	})
	if h.Federation != nil {
		h.Federation.QueueMessageUpdate(messageID, input.EncryptedContent, input.IV, now)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "updated_at": now})
}

func (h *Handler) Delete(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var conversationID int64
	var isPoll, isEvent bool
	err = h.DB.QueryRow(`SELECT conversation_id,
		EXISTS(SELECT 1 FROM poll_options WHERE message_id=messages.id),
		EXISTS(SELECT 1 FROM message_events WHERE message_id=messages.id)
		FROM messages WHERE id=? AND sender_id=?`, messageID, auth.UserID(r)).Scan(&conversationID, &isPoll, &isEvent)
	if err != nil {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if !h.isMember(conversationID, auth.UserID(r)) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	tx, err := h.DB.Begin()
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	defer tx.Rollback()
	if _, err = tx.Exec(`UPDATE messages SET reply_to=NULL WHERE reply_to=?`, messageID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	result, err := tx.Exec(`DELETE FROM messages WHERE id=?`, messageID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "delete failed")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "message_deleted", "conversation_id": conversationID, "message_id": messageID,
	})
	if isPoll && h.Federation != nil {
		h.Federation.QueuePollDelete(conversationID, messageID, auth.UserID(r))
	}
	if isEvent && h.Federation != nil {
		h.Federation.QueueEventDelete(conversationID, messageID, auth.UserID(r))
	}
	if !isPoll && !isEvent && h.Federation != nil {
		h.Federation.QueueMessageDelete(conversationID, messageID, auth.UserID(r))
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) Report(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		Reason string `json:"reason"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	reason := strings.TrimSpace(input.Reason)
	if _, valid := validMessageReportReasons[reason]; !valid {
		httpx.Error(w, http.StatusBadRequest, "invalid message report reason")
		return
	}
	reporterID := auth.UserID(r)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	var senderID int64
	if err := h.DB.QueryRow(`SELECT m.sender_id FROM messages m
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id
			AND cm.user_id=? AND cm.role<>'pending'
		WHERE m.id=? AND m.created_at>=cm.created_at AND (m.expires_at IS NULL OR m.expires_at>?)`,
		reporterID, messageID, now).Scan(&senderID); err != nil {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if senderID == reporterID {
		httpx.Error(w, http.StatusBadRequest, "cannot report own message")
		return
	}
	result, err := h.DB.Exec(`UPDATE message_reports SET reason=?,created_at=? WHERE message_id=? AND reporter_id=?`,
		reason, now, messageID, reporterID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message report failed")
		return
	}
	status := http.StatusOK
	affected, _ := result.RowsAffected()
	if affected == 0 {
		if _, err := h.DB.Exec(`INSERT INTO message_reports(message_id,reporter_id,reason,created_at) VALUES(?,?,?,?)`,
			messageID, reporterID, reason, now); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "message report failed")
			return
		}
		status = http.StatusCreated
	}
	httpx.JSON(w, status, map[string]any{"ok": true, "reason": reason})
}

func (h *Handler) Unreport(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	result, err := h.DB.Exec(`DELETE FROM message_reports WHERE message_id=? AND reporter_id=?`, messageID, auth.UserID(r))
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message report removal failed")
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		httpx.Error(w, http.StatusNotFound, "message report not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) React(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		Emoji string `json:"emoji"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	emoji := strings.TrimSpace(input.Emoji)
	if len([]rune(emoji)) < 1 || len([]rune(emoji)) > 16 {
		httpx.Error(w, http.StatusBadRequest, "invalid reaction")
		return
	}
	userID := auth.UserID(r)
	var conversationID int64
	now := time.Now().UTC().Format(time.RFC3339Nano)
	err = h.DB.QueryRow(`SELECT conversation_id FROM messages WHERE id=? AND (expires_at IS NULL OR expires_at>?)`, messageID, now).Scan(&conversationID)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	var existing int
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?`, messageID, userID, emoji).Scan(&existing); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "reaction update failed")
		return
	}
	if existing > 0 {
		if _, err := h.DB.Exec(`DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND emoji=?`, messageID, userID, emoji); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "reaction update failed")
			return
		}
	} else if _, err := h.DB.Exec(`INSERT INTO message_reactions(message_id,user_id,emoji,created_at) VALUES(?,?,?,?)`, messageID, userID, emoji, now); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "reaction update failed")
		return
	}
	h.broadcastEvent(conversationID, map[string]any{
		"type": "conversation_updated", "conversation_id": conversationID, "reaction_message_id": messageID,
	})
	if h.Federation != nil {
		h.Federation.QueueReaction(messageID, userID, emoji, existing == 0, now)
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true, "active": existing == 0})
}

func (h *Handler) Pin(w http.ResponseWriter, r *http.Request) {
	messageID, err := httpx.PathID(r, "id")
	if err != nil {
		httpx.Error(w, http.StatusBadRequest, err.Error())
		return
	}
	var input struct {
		Pinned bool `json:"pinned"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	userID := auth.UserID(r)
	var conversationID int64
	now := time.Now().UTC().Format(time.RFC3339Nano)
	err = h.DB.QueryRow(`SELECT conversation_id FROM messages WHERE id=? AND (expires_at IS NULL OR expires_at>?)`, messageID, now).Scan(&conversationID)
	if err != nil || !h.isMember(conversationID, userID) {
		httpx.Error(w, http.StatusNotFound, "message not found")
		return
	}
	if input.Pinned {
		var existing int
		err = h.DB.QueryRow(`SELECT COUNT(*) FROM message_pins WHERE message_id=? AND user_id=?`, messageID, userID).Scan(&existing)
		if err == nil && existing == 0 {
			_, err = h.DB.Exec(`INSERT INTO message_pins(message_id,user_id,created_at) VALUES(?,?,?)`, messageID, userID, now)
		}
	} else {
		_, err = h.DB.Exec(`DELETE FROM message_pins WHERE message_id=? AND user_id=?`, messageID, userID)
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "message pin update failed")
		return
	}
	if h.Federation != nil {
		h.Federation.QueuePin(messageID, userID, input.Pinned, now)
	}
	if h.Hub != nil {
		h.Hub.SendToUser(userID, map[string]any{
			"type": "conversation_updated", "conversation_id": conversationID, "pinned_message_id": messageID,
		})
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) isMember(conversationID, userID int64) bool {
	var count int
	return h.DB.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=? AND role<>'pending'`, conversationID, userID).
		Scan(&count) == nil && count == 1
}

func expiryTime(seconds int64) (*string, bool) {
	if seconds == 0 {
		return nil, true
	}
	switch seconds {
	case 300, 3600, 86400, 604800:
		value := time.Now().UTC().Add(time.Duration(seconds) * time.Second).Format(time.RFC3339Nano)
		return &value, true
	default:
		return nil, false
	}
}

// expirySweepInterval throttles the physical removal of expired messages.
// Every read path already filters on `expires_at`, so an expired message is
// never returned; the DELETE is pure housekeeping. Running it on every single
// page load turned each read into a write that takes row locks on the hottest
// table, which is what made the message list contend under load.
const expirySweepInterval = 30 * time.Second

func (h *Handler) deleteExpired(conversationID int64) {
	if !h.expirySweep().due(conversationID, time.Now().UTC()) {
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, _ = h.DB.Exec(`DELETE FROM messages WHERE conversation_id=? AND expires_at IS NOT NULL AND expires_at<=?`, conversationID, now)
}

func (h *Handler) expirySweep() *expirySweeper {
	h.sweepOnce.Do(func() {
		interval := h.ExpirySweepInterval
		if interval == 0 {
			interval = expirySweepInterval
		}
		h.sweep = newExpirySweeper(interval)
	})
	return h.sweep
}

// messageIDArgs returns the SQL placeholder list and the matching arguments for
// the identifiers of a page of messages, plus an index from message id to its
// position in the slice. It returns ok=false when there is nothing to look up.
func messageIDArgs(messages []Message, leading ...any) (string, []any, map[int64]int, bool) {
	if len(messages) == 0 {
		return "", nil, nil, false
	}
	positions := make(map[int64]int, len(messages))
	args := make([]any, 0, len(leading)+len(messages))
	args = append(args, leading...)
	placeholders := make([]byte, 0, 2*len(messages))
	for index := range messages {
		if _, duplicate := positions[messages[index].ID]; duplicate {
			continue
		}
		positions[messages[index].ID] = index
		if len(placeholders) > 0 {
			placeholders = append(placeholders, ',')
		}
		placeholders = append(placeholders, '?')
		args = append(args, messages[index].ID)
	}
	return string(placeholders), args, positions, true
}

// attachReactions loads the reactions of a whole page in a single query. It
// used to issue one query per message, so a 50-message page cost 50 round
// trips; the cost is now independent of the page size.
func (h *Handler) attachReactions(messages []Message, userID int64) {
	placeholders, args, positions, ok := messageIDArgs(messages, userID)
	if !ok {
		return
	}
	rows, err := h.DB.Query(`SELECT message_id,emoji,COUNT(*),SUM(CASE WHEN user_id=? THEN 1 ELSE 0 END)
		FROM message_reactions WHERE message_id IN (`+placeholders+`)
		GROUP BY message_id,emoji ORDER BY message_id,MIN(created_at)`, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var messageID int64
		var reaction Reaction
		var mineCount int
		if rows.Scan(&messageID, &reaction.Emoji, &reaction.Count, &mineCount) != nil {
			continue
		}
		index, known := positions[messageID]
		if !known {
			continue
		}
		reaction.Mine = mineCount > 0
		messages[index].Reactions = append(messages[index].Reactions, reaction)
	}
}

// attachPolls loads every poll of a page in a single query.
func (h *Handler) attachPolls(messages []Message, userID int64) {
	placeholders, args, positions, ok := messageIDArgs(messages, userID)
	if !ok {
		return
	}
	rows, err := h.DB.Query(`SELECT po.message_id,po.id,po.position,COUNT(pv.id),
		COALESCE(SUM(CASE WHEN pv.user_id=? THEN 1 ELSE 0 END),0),m.poll_expires_at
		FROM poll_options po JOIN messages m ON m.id=po.message_id LEFT JOIN poll_votes pv ON pv.option_id=po.id
		WHERE po.message_id IN (`+placeholders+`)
		GROUP BY po.message_id,po.id,po.position,m.poll_expires_at ORDER BY po.message_id,po.position`, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	now := time.Now().UTC()
	for rows.Next() {
		var messageID int64
		var option PollOption
		var mineCount int
		var expiresAt sql.NullString
		if rows.Scan(&messageID, &option.ID, &option.Position, &option.VoteCount, &mineCount, &expiresAt) != nil {
			continue
		}
		index, known := positions[messageID]
		if !known {
			continue
		}
		poll := messages[index].Poll
		if poll == nil {
			poll = &Poll{Options: []PollOption{}}
			messages[index].Poll = poll
		}
		if expiresAt.Valid {
			poll.ExpiresAt = &expiresAt.String
			poll.Closed = pollExpired(expiresAt.String, now)
		}
		option.Mine = mineCount > 0
		poll.HasVoted = poll.HasVoted || option.Mine
		poll.TotalVotes += option.VoteCount
		poll.Options = append(poll.Options, option)
	}
}

// attachEvents loads every calendar event of a page in a single query.
func (h *Handler) attachEvents(messages []Message) {
	placeholders, args, positions, ok := messageIDArgs(messages)
	if !ok {
		return
	}
	rows, err := h.DB.Query(`SELECT message_id,starts_at,ends_at FROM message_events
		WHERE message_id IN (`+placeholders+`)`, args...)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var messageID int64
		var event Event
		if rows.Scan(&messageID, &event.StartsAt, &event.EndsAt) != nil {
			continue
		}
		if index, known := positions[messageID]; known {
			messages[index].Event = &event
		}
	}
}

func (h *Handler) broadcast(message Message) {
	rows, err := h.DB.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND role<>'pending'`, message.ConversationID)
	if err != nil {
		return
	}
	var members []int64
	for rows.Next() {
		var userID int64
		if rows.Scan(&userID) == nil {
			members = append(members, userID)
		}
	}
	rows.Close()
	if len(members) == 1 && members[0] == message.SenderID {
		if h.Hub != nil {
			h.Hub.SendToUser(message.SenderID, map[string]any{"type": "new_message", "message": message})
		}
		h.broadcastEvent(message.ConversationID, map[string]any{"type": "conversation_updated", "conversation_id": message.ConversationID})
		return
	}
	var recipients []int64
	for _, userID := range members {
		if userID != message.SenderID {
			recipients = append(recipients, userID)
		}
	}
	delivered := make([]int64, 0, len(recipients))
	for _, userID := range recipients {
		if h.Hub != nil && h.Hub.SendToUser(userID, map[string]any{"type": "new_message", "message": message}) {
			delivered = append(delivered, userID)
			h.Hub.SendToUser(message.SenderID, map[string]any{"type": "message_delivered", "message_id": message.ID, "conversation_id": message.ConversationID, "user_id": userID})
		}
		if h.Push != nil {
			go h.Push.NotifyUser(userID)
		}
	}
	// One statement for the whole group instead of one per online recipient.
	if len(delivered) > 0 {
		placeholders := make([]byte, 0, 2*len(delivered))
		args := make([]any, 0, len(delivered)+2)
		args = append(args, time.Now().UTC().Format(time.RFC3339Nano), message.ID)
		for _, userID := range delivered {
			if len(placeholders) > 0 {
				placeholders = append(placeholders, ',')
			}
			placeholders = append(placeholders, '?')
			args = append(args, userID)
		}
		_, _ = h.DB.Exec(`UPDATE message_receipts SET status='delivered',created_at=?
			WHERE message_id=? AND status='sent' AND user_id IN (`+string(placeholders)+`)`, args...)
	}
	h.broadcastEvent(message.ConversationID, map[string]any{"type": "conversation_updated", "conversation_id": message.ConversationID})
}

func (h *Handler) broadcastEvent(conversationID int64, event any) {
	rows, err := h.DB.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND role<>'pending'`, conversationID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var userID int64
		if rows.Scan(&userID) == nil && h.Hub != nil {
			h.Hub.SendToUser(userID, event)
		}
	}
}
