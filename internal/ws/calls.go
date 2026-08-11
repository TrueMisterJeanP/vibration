package ws

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"chat-pwa-go/internal/callsig"
)

// CallRouter is the federated half of call signalling. It is separate from
// FederationRouter because a boolean "the relay took it" is not routing
// information: the WebSocket layer has to know *which* participants live
// elsewhere, so it can still deliver to the local ones, and it has to learn the
// per-recipient outcome, so it can tell the caller what failed.
type CallRouter interface {
	// LocalCallIdentity is the canonical identity of a local account.
	LocalCallIdentity(userID int64) (callsig.Identity, bool)
	// RemoteCallRecipient resolves a remote shadow account to its identity and
	// instance. It reports false for accounts that are not federated.
	RemoteCallRecipient(userID int64) (callsig.Recipient, bool)
	// DispatchCall hands the event to another instance without blocking the
	// caller, and reports the outcome through report exactly once.
	DispatchCall(recipient callsig.Recipient, event callsig.Event, report func(callsig.Delivery))
}

// callSignalTypes is kept as the WebSocket-level gate so an unknown frame is
// ignored before any database work happens.
func isCallSignal(value string) bool { return callsig.IsEventType(value) }

// localInstance is the instance part of every identity this server mints.
func (h *Handler) localInstance() string {
	return callsig.NormalizeInstance(h.LocalBaseURL)
}

func (h *Handler) callLedger() *callsig.Ledger {
	h.callOnce.Do(func() {
		h.ledger = callsig.NewLedger()
		h.limiter = callsig.NewRateLimiter()
	})
	return h.ledger
}

func (h *Handler) callLimiter() *callsig.RateLimiter {
	h.callLedger()
	return h.limiter
}

// senderIdentity builds the canonical identity of a local connection.
func (h *Handler) senderIdentity(userID int64) (callsig.Identity, bool) {
	if router, ok := h.Federation.(CallRouter); ok && router != nil {
		if identity, found := router.LocalCallIdentity(userID); found {
			return identity, true
		}
	}
	var username string
	var remote bool
	if h.DB.QueryRow(`SELECT username,is_remote FROM users WHERE id=?`, userID).Scan(&username, &remote) != nil || remote {
		return callsig.Identity{}, false
	}
	return callsig.NewIdentity(h.localInstance(), username), true
}

// callRecipients lists every other participant of a conversation, already split
// between this instance and the federated ones.
//
// The split is computed from the membership table alone. It is never derived
// from whether a relay "accepted" the event, because a conversation routinely
// contains both kinds of member and answering that question with one boolean is
// what let group invitations skip the local members entirely.
func (h *Handler) callRecipients(conversationID, senderID int64) []callsig.Recipient {
	rows, err := h.DB.Query(`SELECT u.id,u.is_remote,u.username,u.remote_username,u.remote_instance_id,i.base_url
		FROM conversation_members cm JOIN users u ON u.id=cm.user_id
		LEFT JOIN federated_instances i ON i.id=u.remote_instance_id
		WHERE cm.conversation_id=? AND cm.user_id<>? AND cm.role<>'pending'`, conversationID, senderID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	local := h.localInstance()
	recipients := []callsig.Recipient{}
	for rows.Next() {
		var userID int64
		var isRemote bool
		var username string
		var remoteUsername, baseURL *string
		var instanceID *int64
		if rows.Scan(&userID, &isRemote, &username, &remoteUsername, &instanceID, &baseURL) != nil {
			continue
		}
		if !isRemote {
			recipients = append(recipients, callsig.Recipient{UserID: userID, Identity: callsig.NewIdentity(local, username)})
			continue
		}
		// A remote member exists locally only as a shadow row. Sending it a
		// WebSocket event would deliver the signal to nobody: there is no
		// browser behind that account on this server.
		if remoteUsername == nil || baseURL == nil || instanceID == nil {
			continue
		}
		recipients = append(recipients, callsig.Recipient{
			UserID:     userID,
			Identity:   callsig.NewIdentity(*baseURL, *remoteUsername),
			InstanceID: *instanceID,
		})
	}
	return recipients
}

// buildCallEvent turns a browser frame into a validated protocol event.
func (h *Handler) buildCallEvent(client *Client, in inboundEvent, recipients []callsig.Recipient) (callsig.Event, bool) {
	sender, ok := h.senderIdentity(client.UserID)
	if !ok {
		return callsig.Event{}, false
	}
	event := callsig.Event{
		EventID:        strings.TrimSpace(in.EventID),
		CallID:         in.CallID,
		Sequence:       in.Sequence,
		Type:           in.Type,
		Media:          in.Media,
		Sender:         sender,
		SDP:            in.SDP,
		Candidate:      in.Candidate,
		Reason:         in.Reason,
		ConversationID: in.ConversationID,
	}
	if event.EventID == "" {
		event.EventID = newEventID()
	}
	if target, found := h.resolveTarget(in, recipients); found {
		event.Target = &target
	} else if in.TargetUserID > 0 || strings.TrimSpace(in.Target.Username) != "" {
		// The frame named a target that is not a member of this conversation.
		return callsig.Event{}, false
	}
	event.Normalize(time.Now())
	return event, event.Validate(time.Now()) == nil
}

// resolveTarget accepts either the canonical identity or, for a client that has
// not yet reloaded, the legacy numeric id. Both are checked against the actual
// membership, so neither can address a stranger.
func (h *Handler) resolveTarget(in inboundEvent, recipients []callsig.Recipient) (callsig.Identity, bool) {
	if candidate := callsig.NewIdentity(in.Target.Instance, in.Target.Username); candidate.Valid() {
		for _, recipient := range recipients {
			if recipient.Identity.Equal(candidate) {
				return recipient.Identity, true
			}
		}
		return callsig.Identity{}, false
	}
	if in.TargetUserID <= 0 {
		return callsig.Identity{}, false
	}
	for _, recipient := range recipients {
		if recipient.UserID == in.TargetUserID {
			return recipient.Identity, true
		}
	}
	return callsig.Identity{}, false
}

// HandleClientFrame routes one decoded client frame through the same path the
// WebSocket reader uses. The timestamps a client may have put on the frame are
// deliberately not honoured: the server stamps the validity window itself, so a
// client cannot mint a signal that stays replayable.
func (h *Handler) HandleClientFrame(userID int64, frame map[string]any) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	var event inboundEvent
	if err := json.Unmarshal(data, &event); err != nil {
		return err
	}
	if !isCallSignal(event.Type) {
		return errors.New("unsupported client frame")
	}
	h.handleCallSignal(&Client{UserID: userID}, event)
	return nil
}

func (h *Handler) handleCallSignal(client *Client, in inboundEvent) {
	in.CallID = strings.TrimSpace(in.CallID)
	in.Media = strings.TrimSpace(in.Media)
	in.Reason = strings.TrimSpace(in.Reason)
	if in.CallID == "" || !h.isMember(in.ConversationID, client.UserID) {
		return
	}
	recipients := h.callRecipients(in.ConversationID, client.UserID)
	event, ok := h.buildCallEvent(client, in, recipients)
	if !ok {
		return
	}
	if !h.callLimiter().Allow(event.Sender, event.Type) {
		h.reportCallFailure(client, event, callsig.Recipient{}, callsig.ReasonRateLimit)
		return
	}
	if accepted, _ := h.callLedger().Accept(event); !accepted {
		return
	}
	for _, recipient := range h.selectedRecipients(event, recipients) {
		h.deliverCallSignal(client, event, recipient)
	}
}

// selectedRecipients narrows a broadcast to its single addressee when the event
// is targeted. A targeted signal goes to exactly one participant: either the
// local hub or that participant's instance, never both.
func (h *Handler) selectedRecipients(event callsig.Event, recipients []callsig.Recipient) []callsig.Recipient {
	if event.Target == nil {
		return recipients
	}
	for _, recipient := range recipients {
		if recipient.Identity.Equal(*event.Target) {
			return []callsig.Recipient{recipient}
		}
	}
	return nil
}

func (h *Handler) deliverCallSignal(client *Client, event callsig.Event, recipient callsig.Recipient) {
	if !recipient.Remote() {
		h.deliverLocalCallSignal(client, event, recipient)
		return
	}
	router, ok := h.Federation.(CallRouter)
	if !ok || router == nil {
		h.reportCallFailure(client, event, recipient, callsig.ReasonUnsupported)
		return
	}
	senderUserID := client.UserID
	router.DispatchCall(recipient, event, func(delivery callsig.Delivery) {
		if delivery.OK() {
			return
		}
		h.sendCallFailure(senderUserID, event, delivery.Recipient, delivery.Reason)
	})
}

func (h *Handler) deliverLocalCallSignal(client *Client, event callsig.Event, recipient callsig.Recipient) {
	payload := callsig.ClientEvent{Event: event, UserID: client.UserID}
	if event.Target != nil {
		payload.TargetUserID = recipient.UserID
	}
	if h.Hub.SendCallToUser(recipient.UserID, payload) {
		return
	}
	reason := callsig.ReasonRecipientOffline
	if h.Hub.IsOnline(recipient.UserID) {
		reason = callsig.ReasonQueueFull
	}
	h.reportCallFailure(client, event, recipient, reason)
}

func (h *Handler) reportCallFailure(client *Client, event callsig.Event, recipient callsig.Recipient, reason string) {
	h.sendCallFailure(client.UserID, event, recipient, reason)
}

func (h *Handler) sendCallFailure(senderUserID int64, event callsig.Event, recipient callsig.Recipient, reason string) {
	// "Still being delivered" is not a failure. The peer accepted the event and
	// is very likely about to hand it to a browser; turning that into a
	// call_signal_failed would tear down a call that is connecting. Nothing is
	// announced either way — the call's own timeout decides.
	if reason == callsig.ReasonInProgress {
		return
	}
	// A hangup or a rejection that nobody received is not worth surfacing: the
	// call is over on this side either way, and reporting it would only produce
	// an error toast after the user already hung up.
	if event.Terminal() {
		return
	}
	h.Hub.SendCallToUser(senderUserID, callsig.NewFailure(event, recipient.Identity, recipient.UserID, reason))
}

func newEventID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "evt-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}
