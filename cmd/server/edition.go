package main

import (
	"database/sql"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/config"
	database "chat-pwa-go/internal/db"
	"chat-pwa-go/internal/settings"
	"chat-pwa-go/internal/ws"
)

type editionRouteDeps struct {
	DB                 *sql.DB
	Hub                *ws.Hub
	Auth               *auth.Handler
	Federation         any
	WebRTCDefaults     settings.WebRTCDefaults
	SQLitePath         string
	DatabaseConfigPath string
	ActiveDatabase     database.ActiveConfig
	ConfiguredDatabase database.ActiveConfig
	RestartCommand     []string
}

type federationWorkerConfig struct {
	BatchSize     int
	PollInterval  time.Duration
	WorkerCount   int
	LockDuration  time.Duration
	SentRetention time.Duration
}

func communitySTUNDefaults() settings.WebRTCDefaults {
	urls := []string{"stun:stun.l.google.com:19302"}
	return settings.WebRTCDefaults{
		ICEServers:         []config.ICEServer{{URLs: urls}},
		PublicFallbackURLs: urls,
	}
}
