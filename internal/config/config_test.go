package config

import (
	"strings"
	"testing"
)

func TestWebRTCICEServersIncludesConfiguredTURN(t *testing.T) {
	t.Setenv("WEBRTC_TURN_URLS", "turn:turn.example.com:3478, turns:turn.example.com:5349 ")
	t.Setenv("WEBRTC_TURN_USERNAME", "turn-user")
	t.Setenv("WEBRTC_TURN_CREDENTIAL", "turn-secret")

	servers := webRTCICEServers()
	if len(servers) != 2 {
		t.Fatalf("servers=%d", len(servers))
	}
	turn := servers[0]
	if len(turn.URLs) != 2 || turn.URLs[0] != "turn:turn.example.com:3478" || turn.URLs[1] != "turns:turn.example.com:5349" {
		t.Fatalf("turn urls=%v", turn.URLs)
	}
	if turn.Username != "turn-user" || turn.Credential != "turn-secret" {
		t.Fatalf("turn credentials=%q/%q", turn.Username, turn.Credential)
	}
	if servers[1].URLs[0] != "stun:stun.l.google.com:19302" {
		t.Fatalf("default stun=%v", servers[1].URLs)
	}
}

func TestLoadRejectsWildcardClientOrigin(t *testing.T) {
	t.Setenv("DATA_DIR", t.TempDir())
	t.Setenv("CLIENT_ORIGINS", "*")

	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "explicit origins") {
		t.Fatalf("Load() error=%v", err)
	}
}

func TestLoadAcceptsExplicitClientOrigins(t *testing.T) {
	t.Setenv("DATA_DIR", t.TempDir())
	t.Setenv("CLIENT_ORIGINS", "https://app.example.com, tauri://localhost/")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.ClientOrigins) != 2 || cfg.ClientOrigins[0] != "https://app.example.com" || cfg.ClientOrigins[1] != "tauri://localhost" {
		t.Fatalf("client origins=%v", cfg.ClientOrigins)
	}
}
