//go:build community

package main

import (
	"database/sql"
	"net/http"

	database "chat-pwa-go/internal/db"
	"chat-pwa-go/internal/messages"
	"chat-pwa-go/internal/settings"
	"chat-pwa-go/internal/ws"
)

func editionInfo() map[string]any {
	return map[string]any{
		"edition":       "community",
		"admin_panel":   false,
		"manager_panel": false,
		"federation":    false,
		"database":      "sqlite",
		"activation":    false,
		"ice_servers":   []string{"stun:stun.l.google.com:19302"},
	}
}

func registerEditionRoutes(_ *http.ServeMux, _ editionRouteDeps) {}

type communityDatabaseMaintenance struct{}

func (communityDatabaseMaintenance) Middleware(next http.Handler) http.Handler { return next }

func (communityDatabaseMaintenance) RunShared(operation func()) bool {
	operation()
	return true
}

func editionDatabaseMaintenance() databaseMaintenance { return communityDatabaseMaintenance{} }

func editionDatabaseConfig(_ database.ActiveConfig) database.ActiveConfig {
	return database.ActiveConfig{Driver: "sqlite"}
}

// editionSupportsExternalDatabase reports false because the community edition
// runs on SQLite by design: selecting sqlite there is the documented behaviour,
// not an accidental fallback.
func editionSupportsExternalDatabase() bool {
	return false
}

func editionDisableRegistration(_ bool) bool {
	return false
}

func editionDisableInvitationCode() bool {
	return true
}

func editionWebRTCDefaults(_ settings.WebRTCDefaults) settings.WebRTCDefaults {
	return communitySTUNDefaults()
}

func editionWebRTCConfig(_ *sql.DB, defaults settings.WebRTCDefaults) (settings.WebRTCConfig, error) {
	return settings.WebRTCConfig{
		ICEServers:            defaults.ICEServers,
		PublicFallbackURLs:    defaults.PublicFallbackURLs,
		RelayPolicy:           settings.NormalizeRelayPolicy(defaults.RelayPolicy),
		PrivateTURNConfigured: false,
		Source:                "community",
	}, nil
}

func registerFederationRoutes(_ *http.ServeMux, _ editionRouteDeps) {}

func startFederationWorkers(_ editionRouteDeps, _ federationWorkerConfig) {}

func newEditionFederation(_ *sql.DB, _ *ws.Hub, _ messages.PushSender, _ string) messages.FederationRouter {
	return nil
}

// editionCallCapability always reports support: without federation every call
// stays inside this instance, which necessarily speaks its own protocol.
func editionCallCapability(_ messages.FederationRouter, _ int64) (bool, string) {
	return true, ""
}
