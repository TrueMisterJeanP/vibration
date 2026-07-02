package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr                          string
	DatabaseDriver                string
	DatabaseDSN                   string
	DatabaseConfigPath            string
	DatabasePath                  string
	DataDir                       string
	AppSecret                     string
	SecureCookies                 bool
	VAPIDSubject                  string
	DisableRegistration           bool
	AuthRateLimitPerMinute        int
	ClientOrigins                 []string
	ServiceRestartCommand         []string
	WebRTCICEServers              []ICEServer
	WebRTCPublicFallbacks         []string
	SessionSameSite               string
	FederationBaseURL             string
	FederationOutboxBatch         int
	FederationOutboxEvery         time.Duration
	FederationOutboxWorkers       int
	FederationOutboxSentRetention time.Duration
}

type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func Load() (Config, error) {
	dataDir := env("DATA_DIR", "data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return Config{}, err
	}
	secret := os.Getenv("APP_SECRET")
	if secret == "" {
		var err error
		secret, err = loadOrCreateSecret(filepath.Join(dataDir, "app_secret"))
		if err != nil {
			return Config{}, err
		}
	}
	return Config{
		Addr:                          env("ADDR", ":8080"),
		DatabaseDriver:                strings.ToLower(env("DATABASE_DRIVER", "sqlite")),
		DatabaseDSN:                   os.Getenv("DATABASE_DSN"),
		DatabaseConfigPath:            filepath.Join(dataDir, "database_config.json"),
		DatabasePath:                  env("DATABASE_PATH", filepath.Join(dataDir, "chat.db")),
		DataDir:                       dataDir,
		AppSecret:                     secret,
		SecureCookies:                 os.Getenv("SECURE_COOKIES") == "true",
		VAPIDSubject:                  env("VAPID_SUBJECT", "admin@example.com"),
		DisableRegistration:           os.Getenv("DISABLE_REGISTRATION") == "true",
		AuthRateLimitPerMinute:        envInt("AUTH_RATE_LIMIT_PER_MINUTE", 20),
		ClientOrigins:                 envList("CLIENT_ORIGINS"),
		ServiceRestartCommand:         envFields("SERVICE_RESTART_COMMAND"),
		WebRTCICEServers:              webRTCICEServers(),
		WebRTCPublicFallbacks:         webRTCPublicFallbackURLs(),
		SessionSameSite:               strings.ToLower(env("SESSION_SAME_SITE", "lax")),
		FederationBaseURL:             strings.TrimRight(env("FEDERATION_BASE_URL", ""), "/"),
		FederationOutboxBatch:         envIntRange("FEDERATION_OUTBOX_BATCH", 20, 1, 1000),
		FederationOutboxEvery:         time.Duration(envIntRange("FEDERATION_OUTBOX_INTERVAL_SECONDS", 30, 1, 3600)) * time.Second,
		FederationOutboxWorkers:       envIntRange("FEDERATION_OUTBOX_WORKERS", 1, 1, 32),
		FederationOutboxSentRetention: time.Duration(envIntRange("FEDERATION_OUTBOX_SENT_RETENTION_HOURS", 24, 1, 24*365)) * time.Hour,
	}, nil
}

func webRTCICEServers() []ICEServer {
	servers := []ICEServer{}
	turnURLs := envList("WEBRTC_TURN_URLS")
	if len(turnURLs) > 0 {
		turn := ICEServer{
			URLs:       turnURLs,
			Username:   os.Getenv("WEBRTC_TURN_USERNAME"),
			Credential: os.Getenv("WEBRTC_TURN_CREDENTIAL"),
		}
		servers = append(servers, turn)
	}
	servers = append(servers, ICEServer{URLs: webRTCPublicFallbackURLs()})
	return servers
}

func webRTCPublicFallbackURLs() []string {
	values := envList("WEBRTC_PUBLIC_FALLBACK_URLS")
	if len(values) > 0 {
		return values
	}
	return []string{"stun:stun.l.google.com:19302"}
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value < 0 {
		return fallback
	}
	return value
}

func envIntRange(name string, fallback, minimum, maximum int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value < minimum || value > maximum {
		return fallback
	}
	return value
}

func envList(name string) []string {
	raw := strings.Split(os.Getenv(name), ",")
	values := make([]string, 0, len(raw))
	for _, value := range raw {
		value = strings.TrimRight(strings.TrimSpace(value), "/")
		if value != "" {
			values = append(values, value)
		}
	}
	return values
}

func envFields(name string) []string {
	return strings.Fields(os.Getenv(name))
}

func loadOrCreateSecret(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err == nil && len(data) >= 32 {
		return string(data), nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	raw := make([]byte, 48)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	secret := base64.RawURLEncoding.EncodeToString(raw)
	if err := os.WriteFile(path, []byte(secret), 0o600); err != nil {
		return "", err
	}
	return secret, nil
}

func LoadOrCreateJSON[T any](path string, create func() (T, error)) (T, error) {
	var value T
	data, err := os.ReadFile(path)
	if err == nil {
		err = json.Unmarshal(data, &value)
		return value, err
	}
	if !errors.Is(err, os.ErrNotExist) {
		return value, err
	}
	value, err = create()
	if err != nil {
		return value, err
	}
	data, err = json.MarshalIndent(value, "", "  ")
	if err != nil {
		return value, err
	}
	err = os.WriteFile(path, data, 0o600)
	return value, err
}
