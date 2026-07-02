package settings

import (
	"path/filepath"
	"testing"

	"chat-pwa-go/internal/config"
	database "chat-pwa-go/internal/db"
)

func TestEffectiveWebRTCConfigUsesDefaultsWithoutAdminSettings(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	defaults := WebRTCDefaults{
		ICEServers: []config.ICEServer{
			{URLs: []string{"turn:turn.example.com:3478"}, Username: "env-user", Credential: "env-secret"},
			{URLs: []string{"stun:stun.l.google.com:19302"}},
		},
		PublicFallbackURLs: []string{"stun:stun.l.google.com:19302"},
	}
	result, err := EffectiveWebRTCConfig(db, defaults)
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "environment" || !result.PrivateTURNConfigured {
		t.Fatalf("unexpected default result: %#v", result)
	}
	if result.ICEServers[0].URLs[0] != "turn:turn.example.com:3478" {
		t.Fatalf("turn priority lost: %#v", result.ICEServers)
	}
}

func TestEffectiveWebRTCConfigUsesAdminSettings(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := SaveWebRTCSettings(db, WebRTCSettings{
		TURNURLs:           []string{"turn:admin.example.com:3478"},
		TURNUsername:       "admin-user",
		TURNCredential:     "admin-secret",
		PublicFallbackURLs: []string{"stun:fallback.example.com:19302"},
	}); err != nil {
		t.Fatal(err)
	}
	result, err := EffectiveWebRTCConfig(db, WebRTCDefaults{
		ICEServers:         []config.ICEServer{{URLs: []string{"turn:env.example.com:3478"}}},
		PublicFallbackURLs: []string{"stun:stun.l.google.com:19302"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "admin" || !result.PrivateTURNConfigured {
		t.Fatalf("unexpected admin result: %#v", result)
	}
	if result.ICEServers[0].URLs[0] != "turn:admin.example.com:3478" || result.ICEServers[1].URLs[0] != "stun:fallback.example.com:19302" {
		t.Fatalf("unexpected ice order: %#v", result.ICEServers)
	}
}

func TestWebRTCSettingsAppliesTURNTransport(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if err := SaveWebRTCSettings(db, WebRTCSettings{
		TURNURLs:           []string{"turn:admin.example.com:3478"},
		TURNTransport:      TURNTransportTLS,
		TURNUsername:       "admin-user",
		TURNCredential:     "admin-secret",
		PublicFallbackURLs: []string{"stun:fallback.example.com:19302"},
	}); err != nil {
		t.Fatal(err)
	}
	encrypted, _, err := LoadWebRTCSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	if encrypted.TURNTransport != TURNTransportTLS || encrypted.TURNURLs[0] != "turns:admin.example.com:3478" {
		t.Fatalf("encrypted transport not applied: %#v", encrypted)
	}

	if err := SaveWebRTCSettings(db, WebRTCSettings{
		TURNURLs:           []string{"turns:admin.example.com:5349"},
		TURNTransport:      TURNTransportPlain,
		TURNUsername:       "admin-user",
		TURNCredential:     "admin-secret",
		PublicFallbackURLs: []string{"stun:fallback.example.com:19302"},
	}); err != nil {
		t.Fatal(err)
	}
	plain, _, err := LoadWebRTCSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	if plain.TURNTransport != TURNTransportPlain || plain.TURNURLs[0] != "turn:admin.example.com:5349" {
		t.Fatalf("plain transport not applied: %#v", plain)
	}
}
