package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequestSessionIDRejectsQueryStringToken(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/ws?session_token=secret-in-url", nil)
	if token, ok := requestSessionID(request); ok || token != "" {
		t.Fatalf("query-string session token accepted: token=%q ok=%v", token, ok)
	}
}

func TestRequestSessionIDAcceptsWebSocketAuthProtocol(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/ws", nil)
	request.Header.Set("Sec-WebSocket-Protocol", "chat, vibration-auth.desktop-session-token")
	if token, ok := requestSessionID(request); !ok || token != "desktop-session-token" {
		t.Fatalf("websocket protocol session token=%q ok=%v", token, ok)
	}
}

func TestRequestSessionIDIgnoresWebSocketAuthProtocolOutsideWebSocketRoute(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/me", nil)
	request.Header.Set("Sec-WebSocket-Protocol", "vibration-auth.desktop-session-token")
	if token, ok := requestSessionID(request); ok || token != "" {
		t.Fatalf("websocket protocol accepted on API route: token=%q ok=%v", token, ok)
	}
}
