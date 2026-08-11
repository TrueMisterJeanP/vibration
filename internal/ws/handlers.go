package ws

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/callsig"
	"github.com/gorilla/websocket"
)

type Handler struct {
	DB            *sql.DB
	Hub           *Hub
	ClientOrigins []string
	Federation    FederationRouter
	// LocalBaseURL is this instance's federation base URL. It is the instance
	// half of every canonical identity minted here; when it is empty the
	// identities stay local-only, which is exactly right for a deployment that
	// does not federate.
	LocalBaseURL string

	callOnce sync.Once
	ledger   *callsig.Ledger
	limiter  *callsig.RateLimiter
}

type FederationRouter interface {
	RelayRealtime(conversationID, senderID int64, event map[string]any) bool
	RelayPresence(userID int64, online bool)
}

type inboundEvent struct {
	Type           string `json:"type"`
	ConversationID int64  `json:"conversation_id"`
	// TargetUserID is the legacy addressing form. It is still accepted so a
	// client that has not reloaded keeps working, but it is resolved against the
	// membership and immediately replaced by the canonical identity.
	TargetUserID int64                       `json:"target_user_id"`
	Target       callsig.Identity            `json:"target"`
	Typing       bool                        `json:"typing"`
	EventID      string                      `json:"event_id"`
	CallID       string                      `json:"call_id"`
	Sequence     int64                       `json:"sequence"`
	Media        string                      `json:"media"`
	Reason       string                      `json:"reason"`
	SDP          *callsig.SessionDescription `json:"sdp"`
	Candidate    *callsig.IceCandidate       `json:"candidate"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			return allowOrigin(r.Header.Get("Origin"), r.Host, h.ClientOrigins)
		},
	}
	connection, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	userID := auth.UserID(r)
	client := NewClient(userID)
	first := h.Hub.Register(client)
	h.sendPresenceState(userID)
	if first {
		h.broadcastPresence(userID, "user_online")
		if h.Federation != nil {
			h.Federation.RelayPresence(userID, true)
		}
	}
	go h.writeLoop(connection, client)
	h.readLoop(connection, client)
	last := h.Hub.Unregister(client)
	close(client.Send)
	close(client.Call)
	_ = connection.Close()
	if last {
		h.broadcastPresence(userID, "user_offline")
		if h.Federation != nil {
			h.Federation.RelayPresence(userID, false)
		}
	}
}

func allowOrigin(origin, host string, allowed []string) bool {
	origin = strings.TrimRight(origin, "/")
	if origin == "" || origin == "http://"+host || origin == "https://"+host {
		return true
	}
	for _, value := range allowed {
		value = strings.TrimRight(strings.TrimSpace(value), "/")
		if value != "*" && value == origin {
			return true
		}
	}
	return false
}

func (h *Handler) writeLoop(connection *websocket.Conn, client *Client) {
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-client.Done:
			_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if client.policyClose.Load() {
				_ = connection.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "account disabled"))
			} else {
				// Backpressure or shutdown: ask the client to come back. It
				// refetches conversations and messages on reconnect, so the
				// events that did not fit in the queue are not lost.
				_ = connection.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseTryAgainLater, "resync required"))
			}
			_ = connection.Close()
			return
		case message := <-client.Kick:
			_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
			_ = connection.WriteMessage(websocket.TextMessage, message)
			_ = connection.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "account disabled"))
			_ = connection.Close()
			return
		case message, ok := <-client.Send:
			_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = connection.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if connection.WriteMessage(websocket.TextMessage, message) != nil {
				return
			}
		case message, ok := <-client.Call:
			_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = connection.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if connection.WriteMessage(websocket.TextMessage, message) != nil {
				return
			}
		case <-ticker.C:
			_ = connection.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if connection.WriteMessage(websocket.PingMessage, nil) != nil {
				return
			}
		}
	}
}

func (h *Handler) readLoop(connection *websocket.Conn, client *Client) {
	defer connection.Close()
	connection.SetReadLimit(128 << 10)
	_ = connection.SetReadDeadline(time.Now().Add(60 * time.Second))
	connection.SetPongHandler(func(string) error {
		return connection.SetReadDeadline(time.Now().Add(60 * time.Second))
	})
	for {
		var event inboundEvent
		if err := connection.ReadJSON(&event); err != nil {
			return
		}
		if event.Type == "typing" && h.isMember(event.ConversationID, client.UserID) {
			out := map[string]any{
				"type": "typing", "conversation_id": event.ConversationID,
				"user_id": client.UserID, "typing": event.Typing,
			}
			// Typing is ephemeral: it may be dropped when a peer's queue is
			// saturated rather than displacing a durable event.
			h.broadcastConversation(event.ConversationID, client.UserID, out, true)
			if h.Federation != nil {
				h.Federation.RelayRealtime(event.ConversationID, client.UserID, out)
			}
			continue
		}
		if isCallSignal(event.Type) {
			// handleCallSignal never blocks: federated hops are handed to the
			// dispatcher, so a remote instance that takes twelve seconds to
			// answer cannot stall this connection's reader.
			h.handleCallSignal(client, event)
		}
	}
}

func (h *Handler) isMember(conversationID, userID int64) bool {
	var count int
	return conversationID > 0 && h.DB.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=? AND role<>'pending'`,
		conversationID, userID).Scan(&count) == nil && count == 1
}

func (h *Handler) isPrivateConversationMember(conversationID, userID int64) bool {
	var count int
	var kind string
	err := h.DB.QueryRow(`SELECT c.type,COUNT(cm.user_id)
		FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
		WHERE c.id=? AND EXISTS(
			SELECT 1 FROM conversation_members own WHERE own.conversation_id=c.id AND own.user_id=? AND own.role<>'pending'
		)
		GROUP BY c.id,c.type`, conversationID, userID).Scan(&kind, &count)
	return err == nil && kind == "private" && count == 2
}

func (h *Handler) broadcastConversation(conversationID, except int64, event any, ephemeral bool) {
	rows, err := h.DB.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id<>? AND role<>'pending'`, conversationID, except)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var userID int64
		if rows.Scan(&userID) != nil {
			continue
		}
		if ephemeral {
			h.Hub.SendEphemeralToUser(userID, event)
			continue
		}
		h.Hub.SendToUser(userID, event)
	}
}

func (h *Handler) broadcastPresence(userID int64, kind string) {
	rows, err := h.DB.Query(`SELECT DISTINCT cm2.user_id
		FROM conversation_members cm1 JOIN conversation_members cm2 ON cm2.conversation_id=cm1.conversation_id
		WHERE cm1.user_id=? AND cm1.role<>'pending' AND cm2.user_id<>? AND cm2.role<>'pending'`, userID, userID)
	if err != nil {
		return
	}
	defer rows.Close()
	event, _ := json.Marshal(map[string]any{"type": kind, "user_id": userID})
	for rows.Next() {
		var target int64
		if rows.Scan(&target) == nil {
			// Presence is ephemeral: the authoritative state is resent in full
			// as `presence_state` whenever a client (re)connects.
			h.Hub.SendEphemeralToUser(target, event)
		}
	}
}

func (h *Handler) sendPresenceState(userID int64) {
	rows, err := h.DB.Query(`SELECT DISTINCT cm2.user_id
		FROM conversation_members cm1 JOIN conversation_members cm2 ON cm2.conversation_id=cm1.conversation_id
		WHERE cm1.user_id=? AND cm1.role<>'pending' AND cm2.user_id<>? AND cm2.role<>'pending'`, userID, userID)
	if err != nil {
		return
	}
	defer rows.Close()
	online := make([]int64, 0)
	for rows.Next() {
		var peerID int64
		if rows.Scan(&peerID) == nil && h.Hub.IsOnline(peerID) {
			online = append(online, peerID)
		}
	}
	h.Hub.SendEphemeralToUser(userID, map[string]any{"type": "presence_state", "online_user_ids": online})
}
