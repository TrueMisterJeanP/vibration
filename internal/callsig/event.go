package callsig

import (
	"errors"
	"strings"
	"time"
)

// Version is the wire version of the federated call protocol. It is also the
// capability string instances advertise; an instance that only announces the
// unversioned "federated-calls" predates typed envelopes, expiry and delivery
// acknowledgements and must not be treated as compatible.
const Version = "federated-calls-v1"

// Capability is the feature name advertised on /.well-known/webtchat.
const Capability = Version

const (
	// DefaultTTL bounds how long a signal stays meaningful. WebRTC signalling is
	// a live handshake: an offer that arrives a minute late describes transport
	// candidates that no longer exist, so replaying it can only break a call
	// that has since been renegotiated or hung up.
	DefaultTTL = 30 * time.Second
	// MaxTTL rejects a peer that tries to keep an event replayable.
	MaxTTL = 2 * time.Minute
	// MaxClockSkew tolerates modest disagreement between instance clocks
	// without widening the replay window.
	MaxClockSkew = 30 * time.Second

	maxCallIDLength    = 96
	maxEventIDLength   = 96
	maxReasonLength    = 160
	maxSDPLength       = 96 << 10
	maxCandidateLength = 16 << 10
	maxSequence        = int64(1) << 40
)

// Event types carried by the protocol.
const (
	TypeInvite    = "call_invite"
	TypeAccept    = "call_accept"
	TypeReject    = "call_reject"
	TypeOffer     = "call_offer"
	TypeAnswer    = "call_answer"
	TypeCandidate = "ice_candidate"
	TypeHangup    = "call_hangup"
	TypeResync    = "call_resync"
)

// Failure is the event delivered back to a caller whose signal could not be
// handed to the intended recipient.
const TypeFailed = "call_signal_failed"

var eventTypes = map[string]struct{}{
	TypeInvite: {}, TypeAccept: {}, TypeReject: {}, TypeOffer: {},
	TypeAnswer: {}, TypeCandidate: {}, TypeHangup: {}, TypeResync: {},
}

// IsEventType reports whether a WebSocket frame is a call signal.
func IsEventType(value string) bool {
	_, ok := eventTypes[value]
	return ok
}

// Stable failure reasons. They are part of the client contract: the browser
// maps them to user-visible outcomes, so they must not be reworded per call
// site or replaced by a raw transport error.
const (
	ReasonDelivered        = ""
	ReasonRecipientOffline = "recipient_offline"
	ReasonUnknownTarget    = "unknown_target"
	ReasonInstanceInactive = "instance_inactive"
	ReasonTransport        = "transport_error"
	ReasonExpired          = "expired"
	ReasonQueueFull        = "queue_full"
	ReasonUnsupported      = "unsupported_protocol"
	ReasonRejected         = "rejected"
)

// SessionDescription is the subset of RTCSessionDescription that is relayed.
type SessionDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

// IceCandidate is the subset of RTCIceCandidateInit that is relayed.
type IceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *int    `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

// Event is one federated call signal. It is a typed envelope rather than a free
// map so that every hop — the emitting WebSocket, the federated HTTP boundary
// and the receiving WebSocket — validates the exact same fields.
type Event struct {
	Version        string              `json:"version"`
	EventID        string              `json:"event_id"`
	CallID         string              `json:"call_id"`
	Sequence       int64               `json:"sequence"`
	Type           string              `json:"type"`
	Media          string              `json:"media,omitempty"`
	Sender         Identity            `json:"sender"`
	Target         *Identity           `json:"target,omitempty"`
	SDP            *SessionDescription `json:"sdp,omitempty"`
	Candidate      *IceCandidate       `json:"candidate,omitempty"`
	Reason         string              `json:"reason,omitempty"`
	CreatedAt      string              `json:"created_at"`
	ExpiresAt      string              `json:"expires_at"`
	ConversationID int64               `json:"conversation_id,omitempty"`
}

// ClientEvent is the shape delivered to a browser. Numeric identifiers are
// attached here and only here: they are meaningful to the receiving instance's
// own clients and to nobody else.
type ClientEvent struct {
	Event
	UserID       int64 `json:"user_id"`
	TargetUserID int64 `json:"target_user_id,omitempty"`
}

// FailureEvent tells the emitting browser that a signal never reached its
// recipient, with enough context to correlate it with what it sent.
type FailureEvent struct {
	Type           string   `json:"type"`
	Version        string   `json:"version"`
	ConversationID int64    `json:"conversation_id"`
	CallID         string   `json:"call_id"`
	EventID        string   `json:"event_id"`
	SignalType     string   `json:"signal_type"`
	Target         Identity `json:"target"`
	TargetUserID   int64    `json:"target_user_id,omitempty"`
	Reason         string   `json:"reason"`
}

// NewFailure builds the failure event for a target and a stable reason.
func NewFailure(event Event, target Identity, targetUserID int64, reason string) FailureEvent {
	return FailureEvent{
		Type: TypeFailed, Version: Version, ConversationID: event.ConversationID,
		CallID: event.CallID, EventID: event.EventID, SignalType: event.Type,
		Target: target, TargetUserID: targetUserID, Reason: reason,
	}
}

// Normalize trims the free-text fields and fills the defaults an emitting
// server is responsible for.
func (e *Event) Normalize(now time.Time) {
	e.Version = Version
	e.EventID = strings.TrimSpace(e.EventID)
	e.CallID = strings.TrimSpace(e.CallID)
	e.Type = strings.TrimSpace(e.Type)
	e.Media = strings.TrimSpace(e.Media)
	e.Reason = strings.TrimSpace(e.Reason)
	e.Sender = NewIdentity(e.Sender.Instance, e.Sender.Username)
	if e.Target != nil {
		target := NewIdentity(e.Target.Instance, e.Target.Username)
		e.Target = &target
	}
	if e.CreatedAt == "" {
		e.CreatedAt = FormatTime(now)
	}
	if e.ExpiresAt == "" {
		e.ExpiresAt = FormatTime(now.Add(DefaultTTL))
	}
}

// Validate checks every field the protocol constrains. It is called on both
// sides of the federated boundary, so a peer cannot widen a limit by claiming
// its own server already checked it.
func (e Event) Validate(now time.Time) error {
	if e.Version != Version {
		return errors.New("unsupported call protocol version")
	}
	if !IsEventType(e.Type) {
		return errors.New("unsupported call signal type")
	}
	if e.EventID == "" || len(e.EventID) > maxEventIDLength {
		return errors.New("invalid call event id")
	}
	if e.CallID == "" || len(e.CallID) > maxCallIDLength {
		return errors.New("invalid call id")
	}
	if e.Sequence < 0 || e.Sequence > maxSequence {
		return errors.New("invalid call sequence")
	}
	switch e.Media {
	case "", "audio", "video":
	default:
		return errors.New("invalid call media")
	}
	if len(e.Reason) > maxReasonLength {
		return errors.New("invalid call reason")
	}
	if !e.Sender.Valid() {
		return errors.New("invalid call sender identity")
	}
	if e.Target != nil {
		if !e.Target.Valid() {
			return errors.New("invalid call target identity")
		}
		if e.Target.Equal(e.Sender) {
			return errors.New("call signal addressed to its own sender")
		}
	}
	if err := e.validateMedia(); err != nil {
		return err
	}
	return e.validateWindow(now)
}

// validateMedia enforces that a signal carries exactly the payload its type
// implies. The pairing is checked rather than merely the shape: an event of any
// other type must not be able to smuggle a session description into the peer
// connection, and an offer must not arrive carrying an answer.
func (e Event) validateMedia() error {
	switch e.Type {
	case TypeOffer:
		if e.SDP == nil {
			return errors.New("missing session description")
		}
		if e.SDP.Type != "offer" {
			return errors.New("call offer must carry an offer description")
		}
	case TypeAnswer:
		if e.SDP == nil {
			return errors.New("missing session description")
		}
		// "pranswer" is accepted because it is a legitimate provisional answer
		// in the WebRTC state machine; "rollback" never travels, it is a purely
		// local operation on the peer that performs it.
		if e.SDP.Type != "answer" && e.SDP.Type != "pranswer" {
			return errors.New("call answer must carry an answer description")
		}
	case TypeCandidate:
		if e.Candidate == nil {
			return errors.New("missing ice candidate")
		}
		if e.SDP != nil {
			return errors.New("ice candidate must not carry a session description")
		}
	default:
		if e.SDP != nil {
			return errors.New("session description not allowed on this signal type")
		}
		if e.Candidate != nil {
			return errors.New("ice candidate not allowed on this signal type")
		}
	}
	if e.SDP != nil {
		if len(e.SDP.SDP) > maxSDPLength {
			return errors.New("session description too large")
		}
		if e.SDP.SDP == "" {
			return errors.New("empty session description")
		}
	}
	if e.Candidate != nil {
		if len(e.Candidate.Candidate) > maxCandidateLength {
			return errors.New("ice candidate too large")
		}
		if e.Candidate.SDPMid != nil && len(*e.Candidate.SDPMid) > 64 {
			return errors.New("invalid ice candidate mid")
		}
		if e.Candidate.UsernameFragment != nil && len(*e.Candidate.UsernameFragment) > 256 {
			return errors.New("invalid ice candidate fragment")
		}
	}
	return nil
}

func (e Event) validateWindow(now time.Time) error {
	createdAt, err := ParseTime(e.CreatedAt)
	if err != nil {
		return errors.New("invalid call event timestamp")
	}
	expiresAt, err := ParseTime(e.ExpiresAt)
	if err != nil {
		return errors.New("invalid call event expiry")
	}
	if !expiresAt.After(createdAt) {
		return errors.New("invalid call event window")
	}
	if expiresAt.Sub(createdAt) > MaxTTL {
		return errors.New("call event expiry too far ahead")
	}
	if createdAt.After(now.Add(MaxClockSkew)) {
		return errors.New("call event created in the future")
	}
	if e.Expired(now) {
		return errors.New("expired call event")
	}
	return nil
}

// Expired reports whether the event may no longer be delivered.
func (e Event) Expired(now time.Time) bool {
	expiresAt, err := ParseTime(e.ExpiresAt)
	if err != nil {
		return true
	}
	return now.After(expiresAt.Add(MaxClockSkew))
}

// Terminal reports the signals that end a call. They are still delivered when
// the peer state has already been torn down, because their whole purpose is to
// tell the other side to stop.
func (e Event) Terminal() bool {
	return e.Type == TypeHangup || e.Type == TypeReject
}

// FormatTime renders a protocol timestamp.
func FormatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

// ParseTime reads a protocol timestamp.
func ParseTime(value string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, strings.TrimSpace(value))
}
