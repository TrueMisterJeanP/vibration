package ws

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
	"github.com/gorilla/websocket"
)

func TestWebSocketUsesProtocolAuthenticationWithoutURLToken(t *testing.T) {
	db := callSignalTestDB(t)
	expires := time.Now().UTC().Add(time.Hour).Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)`,
		"desktop-session-token", 1, expires, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	handler := &Handler{DB: db, Hub: NewHub()}
	authHandler := &auth.Handler{DB: db}
	server := httptest.NewServer(authHandler.Middleware(handler))
	t.Cleanup(server.Close)
	websocketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/ws"

	connection, response, err := (&websocket.Dialer{Subprotocols: []string{"vibration-auth.desktop-session-token"}}).Dial(websocketURL, nil)
	if err != nil {
		t.Fatalf("protocol-authenticated websocket: %v (response=%v)", err, response)
	}
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("websocket status=%d", response.StatusCode)
	}
	response.Body.Close()
	_ = connection.Close()

	_, response, err = websocket.DefaultDialer.Dial(websocketURL+"?session_token=desktop-session-token", nil)
	if err == nil {
		t.Fatal("query-string websocket authentication unexpectedly succeeded")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("query-string websocket response=%v err=%v", response, err)
	}
	response.Body.Close()
}

func TestAllowOriginRejectsWildcard(t *testing.T) {
	if allowOrigin("https://attacker.example", "server.example", []string{"*"}) {
		t.Fatal("wildcard websocket origin unexpectedly allowed")
	}
	if !allowOrigin("https://client.example", "server.example", []string{"https://client.example/"}) {
		t.Fatal("explicit websocket origin unexpectedly rejected")
	}
}

func TestHandleCallSignalRelaysPrivateConversationEvent(t *testing.T) {
	db := callSignalTestDB(t)
	hub := NewHub()
	handler := &Handler{DB: db, Hub: hub}
	receiver := &Client{UserID: 2, Send: make(chan []byte, 1), Kick: make(chan []byte, 1), Done: make(chan struct{})}
	hub.Register(receiver)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type:           "call_offer",
		ConversationID: 1,
		CallID:         "call-123",
		Media:          "audio",
		SDP:            json.RawMessage(`{"type":"offer","sdp":"v=0"}`),
	})

	select {
	case data := <-receiver.Send:
		var event map[string]any
		if err := json.Unmarshal(data, &event); err != nil {
			t.Fatal(err)
		}
		if event["type"] != "call_offer" || event["call_id"] != "call-123" || event["media"] != "audio" {
			t.Fatalf("unexpected event: %#v", event)
		}
		if event["conversation_id"].(float64) != 1 || event["user_id"].(float64) != 1 {
			t.Fatalf("unexpected ids: %#v", event)
		}
		if _, ok := event["sdp"].(map[string]any); !ok {
			t.Fatalf("missing sdp payload: %#v", event)
		}
	default:
		t.Fatal("expected call signal to be relayed")
	}
}

func TestHandleCallSignalRelaysGroupConversationEvent(t *testing.T) {
	db := callSignalTestDB(t)
	hub := NewHub()
	handler := &Handler{DB: db, Hub: hub}
	firstReceiver := &Client{UserID: 2, Send: make(chan []byte, 1), Kick: make(chan []byte, 1), Done: make(chan struct{})}
	receiver := &Client{UserID: 3, Send: make(chan []byte, 1), Kick: make(chan []byte, 1), Done: make(chan struct{})}
	hub.Register(firstReceiver)
	hub.Register(receiver)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type:           "call_invite",
		ConversationID: 2,
		CallID:         "call-group",
		Media:          "video",
	})

	firstEvent := receiveCallEvent(t, firstReceiver)
	if firstEvent["type"] != "call_invite" || firstEvent["call_id"] != "call-group" || firstEvent["media"] != "video" {
		t.Fatalf("unexpected first group event: %#v", firstEvent)
	}
	event := receiveCallEvent(t, receiver)
	if event["type"] != "call_invite" || event["call_id"] != "call-group" || event["media"] != "video" {
		t.Fatalf("unexpected group event: %#v", event)
	}
	if event["conversation_id"].(float64) != 2 || event["user_id"].(float64) != 1 {
		t.Fatalf("unexpected ids: %#v", event)
	}
}

func TestHandleCallSignalTargetsGroupMember(t *testing.T) {
	db := callSignalTestDB(t)
	hub := NewHub()
	handler := &Handler{DB: db, Hub: hub}
	target := &Client{UserID: 3, Send: make(chan []byte, 1), Kick: make(chan []byte, 1), Done: make(chan struct{})}
	other := &Client{UserID: 2, Send: make(chan []byte, 1), Kick: make(chan []byte, 1), Done: make(chan struct{})}
	hub.Register(target)
	hub.Register(other)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type:           "call_offer",
		ConversationID: 2,
		TargetUserID:   3,
		CallID:         "call-targeted",
		Media:          "video",
		SDP:            json.RawMessage(`{"type":"offer","sdp":"v=0"}`),
	})

	event := receiveCallEvent(t, target)
	if event["type"] != "call_offer" || event["target_user_id"].(float64) != 3 || event["user_id"].(float64) != 1 {
		t.Fatalf("unexpected targeted event: %#v", event)
	}
	select {
	case data := <-other.Send:
		t.Fatalf("unexpected untargeted signal: %s", data)
	default:
	}
}

func TestHandleCallSignalRelaysRejectReason(t *testing.T) {
	db := callSignalTestDB(t)
	hub := NewHub()
	handler := &Handler{DB: db, Hub: hub}
	receiver := &Client{UserID: 1, Send: make(chan []byte, 1), Kick: make(chan []byte, 1), Done: make(chan struct{})}
	hub.Register(receiver)

	handler.handleCallSignal(&Client{UserID: 2}, inboundEvent{
		Type:           "call_reject",
		ConversationID: 1,
		CallID:         "call-rejected",
		Media:          "video",
		Reason:         "busy",
	})

	event := receiveCallEvent(t, receiver)
	if event["type"] != "call_reject" || event["call_id"] != "call-rejected" || event["media"] != "video" || event["reason"] != "busy" {
		t.Fatalf("unexpected reject event: %#v", event)
	}
	if event["conversation_id"].(float64) != 1 || event["user_id"].(float64) != 2 {
		t.Fatalf("unexpected ids: %#v", event)
	}
}

func TestHandleCallSignalRelaysICECandidate(t *testing.T) {
	db := callSignalTestDB(t)
	hub := NewHub()
	handler := &Handler{DB: db, Hub: hub}
	receiver := &Client{UserID: 2, Send: make(chan []byte, 1), Kick: make(chan []byte, 1), Done: make(chan struct{})}
	hub.Register(receiver)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type:           "ice_candidate",
		ConversationID: 1,
		CallID:         "call-ice",
		Media:          "audio",
		Candidate:      json.RawMessage(`{"candidate":"candidate:1","sdpMid":"0","sdpMLineIndex":0}`),
	})

	event := receiveCallEvent(t, receiver)
	if event["type"] != "ice_candidate" || event["call_id"] != "call-ice" {
		t.Fatalf("unexpected candidate event: %#v", event)
	}
	candidate, ok := event["candidate"].(map[string]any)
	if !ok || candidate["candidate"] != "candidate:1" || candidate["sdpMid"] != "0" {
		t.Fatalf("missing candidate payload: %#v", event)
	}
}

func TestHandleCallSignalIgnoresInvalidPayloads(t *testing.T) {
	db := callSignalTestDB(t)
	tests := []struct {
		name  string
		event inboundEvent
	}{
		{
			name: "unknown media",
			event: inboundEvent{
				Type:           "call_invite",
				ConversationID: 1,
				CallID:         "call-invalid-media",
				Media:          "screen",
			},
		},
		{
			name: "oversized call id",
			event: inboundEvent{
				Type:           "call_invite",
				ConversationID: 1,
				CallID:         string(make([]byte, 97)),
				Media:          "audio",
			},
		},
		{
			name: "non member",
			event: inboundEvent{
				Type:           "call_invite",
				ConversationID: 1,
				CallID:         "call-non-member",
				Media:          "audio",
			},
		},
		{
			name: "oversized sdp",
			event: inboundEvent{
				Type:           "call_offer",
				ConversationID: 1,
				CallID:         "call-large-sdp",
				Media:          "audio",
				SDP:            json.RawMessage(string(make([]byte, 96<<10+1))),
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			hub := NewHub()
			handler := &Handler{DB: db, Hub: hub}
			receiver := &Client{UserID: 2, Send: make(chan []byte, 1), Kick: make(chan []byte, 1), Done: make(chan struct{})}
			hub.Register(receiver)
			senderID := int64(1)
			if test.name == "non member" {
				senderID = 3
			}

			handler.handleCallSignal(&Client{UserID: senderID}, test.event)

			select {
			case data := <-receiver.Send:
				t.Fatalf("unexpected signal for invalid payload: %s", data)
			default:
			}
		})
	}
}

func receiveCallEvent(t *testing.T, client *Client) map[string]any {
	t.Helper()
	select {
	case data := <-client.Send:
		var event map[string]any
		if err := json.Unmarshal(data, &event); err != nil {
			t.Fatal(err)
		}
		return event
	default:
		t.Fatal("expected call signal to be relayed")
		return nil
	}
}

func callSignalTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	now := time.Now().UTC().Format(time.RFC3339Nano)
	for _, user := range []struct {
		id       int64
		username string
	}{
		{id: 1, username: "caller"},
		{id: 2, username: "callee"},
		{id: 3, username: "group_peer"},
	} {
		if _, err := db.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
			VALUES(?,?,?,?,?,?,?,?)`, user.id, user.username, user.username, "hash", "public", "private", "salt", now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO conversations(id,type,encrypted_title,created_by,created_at)
		VALUES(1,'private',NULL,1,?),(2,'group','group-title',1,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	for _, member := range []struct {
		conversationID int64
		userID         int64
		role           string
	}{
		{conversationID: 1, userID: 1, role: "owner"},
		{conversationID: 1, userID: 2, role: "member"},
		{conversationID: 2, userID: 1, role: "owner"},
		{conversationID: 2, userID: 2, role: "member"},
		{conversationID: 2, userID: 3, role: "member"},
	} {
		if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
			VALUES(?,?,?,?,?)`, member.conversationID, member.userID, "key", member.role, now); err != nil {
			t.Fatal(err)
		}
	}
	return db
}
