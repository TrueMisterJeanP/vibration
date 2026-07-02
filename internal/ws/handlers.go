package ws

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"chat-pwa-go/internal/auth"
	"github.com/gorilla/websocket"
)

type Handler struct {
	DB            *sql.DB
	Hub           *Hub
	ClientOrigins []string
}

var callSignalTypes = map[string]struct{}{
	"call_invite":   {},
	"call_accept":   {},
	"call_reject":   {},
	"call_offer":    {},
	"call_answer":   {},
	"ice_candidate": {},
	"call_hangup":   {},
}

type inboundEvent struct {
	Type           string          `json:"type"`
	ConversationID int64           `json:"conversation_id"`
	TargetUserID   int64           `json:"target_user_id"`
	Typing         bool            `json:"typing"`
	CallID         string          `json:"call_id"`
	Media          string          `json:"media"`
	Reason         string          `json:"reason"`
	SDP            json.RawMessage `json:"sdp"`
	Candidate      json.RawMessage `json:"candidate"`
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
	client := &Client{UserID: userID, Send: make(chan []byte, 64), Kick: make(chan []byte, 1), Done: make(chan struct{})}
	first := h.Hub.Register(client)
	h.sendPresenceState(userID)
	if first {
		h.broadcastPresence(userID, "user_online")
	}
	go h.writeLoop(connection, client)
	h.readLoop(connection, client)
	last := h.Hub.Unregister(client)
	close(client.Send)
	_ = connection.Close()
	if last {
		h.broadcastPresence(userID, "user_offline")
	}
}

func allowOrigin(origin, host string, allowed []string) bool {
	origin = strings.TrimRight(origin, "/")
	if origin == "" || origin == "http://"+host || origin == "https://"+host {
		return true
	}
	for _, value := range allowed {
		value = strings.TrimRight(strings.TrimSpace(value), "/")
		if value == "*" || value == origin {
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
			_ = connection.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "account disabled"))
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
			h.broadcastConversation(event.ConversationID, client.UserID, map[string]any{
				"type": "typing", "conversation_id": event.ConversationID,
				"user_id": client.UserID, "typing": event.Typing,
			})
			continue
		}
		if _, ok := callSignalTypes[event.Type]; ok {
			h.handleCallSignal(client, event)
		}
	}
}

func (h *Handler) handleCallSignal(client *Client, event inboundEvent) {
	event.CallID = strings.TrimSpace(event.CallID)
	event.Media = strings.TrimSpace(event.Media)
	event.Reason = strings.TrimSpace(event.Reason)
	if event.CallID == "" || len(event.CallID) > 96 || !h.isMember(event.ConversationID, client.UserID) {
		return
	}
	if event.TargetUserID < 0 || event.TargetUserID == client.UserID {
		return
	}
	if event.TargetUserID > 0 && !h.isMember(event.ConversationID, event.TargetUserID) {
		return
	}
	if len(event.Media) > 16 || len(event.Reason) > 160 || len(event.SDP) > 96<<10 || len(event.Candidate) > 16<<10 {
		return
	}
	switch event.Media {
	case "", "audio", "video":
	default:
		return
	}

	out := map[string]any{
		"type":            event.Type,
		"conversation_id": event.ConversationID,
		"user_id":         client.UserID,
		"call_id":         event.CallID,
	}
	if event.TargetUserID > 0 {
		out["target_user_id"] = event.TargetUserID
	}
	if event.Media != "" {
		out["media"] = event.Media
	}
	if event.Reason != "" {
		out["reason"] = event.Reason
	}
	if len(event.SDP) > 0 {
		out["sdp"] = event.SDP
	}
	if len(event.Candidate) > 0 {
		out["candidate"] = event.Candidate
	}
	if event.TargetUserID > 0 {
		h.Hub.SendToUser(event.TargetUserID, out)
		return
	}
	h.broadcastConversation(event.ConversationID, client.UserID, out)
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

func (h *Handler) broadcastConversation(conversationID, except int64, event any) {
	rows, err := h.DB.Query(`SELECT user_id FROM conversation_members WHERE conversation_id=? AND user_id<>? AND role<>'pending'`, conversationID, except)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var userID int64
		if rows.Scan(&userID) == nil {
			h.Hub.SendToUser(userID, event)
		}
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
			h.Hub.SendToUser(target, event)
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
	h.Hub.SendToUser(userID, map[string]any{"type": "presence_state", "online_user_ids": online})
}
