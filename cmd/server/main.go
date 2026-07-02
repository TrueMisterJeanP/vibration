package main

import (
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/config"
	"chat-pwa-go/internal/contacts"
	"chat-pwa-go/internal/conversations"
	database "chat-pwa-go/internal/db"
	"chat-pwa-go/internal/files"
	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/messages"
	"chat-pwa-go/internal/push"
	"chat-pwa-go/internal/settings"
	"chat-pwa-go/internal/users"
	"chat-pwa-go/internal/ws"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	configuredDatabase, _, err := database.LoadActiveConfig(cfg.DatabaseConfigPath, cfg.DatabaseDriver, cfg.DatabaseDSN)
	if err != nil {
		log.Fatal(err)
	}
	configuredDatabase = editionDatabaseConfig(configuredDatabase)
	activeDatabase := configuredDatabase
	db, err := database.OpenConfigured(configuredDatabase.Driver, cfg.DatabasePath, configuredDatabase.DSN)
	if err != nil && !database.IsSQLiteDriver(configuredDatabase.Driver) {
		log.Printf("database %s unavailable, falling back to sqlite: %v", configuredDatabase.Driver, err)
		activeDatabase = database.ActiveConfig{Driver: "sqlite"}
		db, err = database.OpenConfigured("sqlite", cfg.DatabasePath, "")
	}
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	hub := ws.NewHub()
	authHandler := &auth.Handler{
		DB: db, SecureCookies: cfg.SecureCookies, CookieSameSite: sameSiteMode(cfg.SessionSameSite), DisableRegistration: editionDisableRegistration(cfg.DisableRegistration),
		DisableInvitationCode: editionDisableInvitationCode(),
		AuthLimiter:           auth.NewRateLimiter(cfg.AuthRateLimitPerMinute, time.Minute),
	}
	pushHandler, err := push.New(db, cfg.DataDir, cfg.VAPIDSubject)
	if err != nil {
		log.Fatal(err)
	}
	userHandler := &users.Handler{DB: db, Hub: hub}
	contactHandler := &contacts.Handler{DB: db, Hub: hub}
	conversationHandler := &conversations.Handler{DB: db, Hub: hub}
	federationHandler := newEditionFederation(db, hub, pushHandler, cfg.FederationBaseURL)
	messageHandler := &messages.Handler{DB: db, Hub: hub, Push: pushHandler, Federation: federationHandler}
	fileHandler := &files.Handler{DB: db, Hub: hub, Push: pushHandler}
	wsHandler := &ws.Handler{DB: db, Hub: hub, ClientOrigins: cfg.ClientOrigins}
	webRTCDefaults := editionWebRTCDefaults(settings.WebRTCDefaults{ICEServers: cfg.WebRTCICEServers, PublicFallbackURLs: cfg.WebRTCPublicFallbacks})
	routeDeps := editionRouteDeps{
		DB: db, Hub: hub, Auth: authHandler, Federation: federationHandler,
		WebRTCDefaults: webRTCDefaults, SQLitePath: cfg.DatabasePath,
		DatabaseConfigPath: cfg.DatabaseConfigPath, ActiveDatabase: activeDatabase,
		ConfiguredDatabase: configuredDatabase, RestartCommand: cfg.ServiceRestartCommand,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/edition", func(w http.ResponseWriter, _ *http.Request) {
		httpx.JSON(w, http.StatusOK, editionInfo())
	})
	mux.HandleFunc("GET /api/registration", authHandler.RegistrationSettings)
	mux.HandleFunc("POST /api/register", authHandler.Register)
	mux.HandleFunc("POST /api/login", authHandler.Login)
	mux.HandleFunc("POST /api/password/reset", authHandler.ResetPassword)
	mux.Handle("POST /api/logout", authHandler.Middleware(http.HandlerFunc(authHandler.Logout)))
	mux.Handle("GET /api/me", authHandler.Middleware(http.HandlerFunc(authHandler.Me)))
	mux.Handle("PUT /api/me", authHandler.Middleware(http.HandlerFunc(userHandler.UpdateProfile)))
	mux.Handle("POST /api/me/recovery-code", authHandler.Middleware(http.HandlerFunc(authHandler.RecoveryCode)))
	mux.Handle("GET /api/users/search", authHandler.Middleware(http.HandlerFunc(userHandler.Search)))
	mux.Handle("GET /api/contacts", authHandler.Middleware(http.HandlerFunc(contactHandler.List)))
	mux.Handle("POST /api/contacts", authHandler.Middleware(http.HandlerFunc(contactHandler.Create)))
	mux.Handle("POST /api/contacts/{id}/accept", authHandler.Middleware(http.HandlerFunc(contactHandler.Accept)))
	mux.Handle("DELETE /api/contacts/{id}", authHandler.Middleware(http.HandlerFunc(contactHandler.Delete)))
	mux.Handle("GET /api/conversations", authHandler.Middleware(http.HandlerFunc(conversationHandler.List)))
	mux.Handle("POST /api/conversations/private", authHandler.Middleware(http.HandlerFunc(conversationHandler.CreatePrivate)))
	mux.Handle("POST /api/conversations/group", authHandler.Middleware(http.HandlerFunc(conversationHandler.CreateGroup)))
	mux.Handle("GET /api/conversations/{id}", authHandler.Middleware(http.HandlerFunc(conversationHandler.Get)))
	mux.Handle("POST /api/conversations/{id}/accept", authHandler.Middleware(http.HandlerFunc(conversationHandler.Accept)))
	mux.Handle("PUT /api/conversations/{id}", authHandler.Middleware(http.HandlerFunc(conversationHandler.Update)))
	mux.Handle("DELETE /api/conversations/{id}", authHandler.Middleware(http.HandlerFunc(conversationHandler.Delete)))
	mux.Handle("GET /api/conversations/{id}/members", authHandler.Middleware(http.HandlerFunc(conversationHandler.Members)))
	mux.Handle("POST /api/conversations/{id}/members", authHandler.Middleware(http.HandlerFunc(conversationHandler.AddMember)))
	mux.Handle("DELETE /api/conversations/{id}/members/{user_id}", authHandler.Middleware(http.HandlerFunc(conversationHandler.RemoveMember)))
	mux.Handle("GET /api/conversations/{id}/messages", authHandler.Middleware(http.HandlerFunc(messageHandler.List)))
	mux.Handle("POST /api/conversations/{id}/messages", authHandler.Middleware(http.HandlerFunc(messageHandler.Create)))
	mux.Handle("POST /api/messages/{id}/read", authHandler.Middleware(http.HandlerFunc(messageHandler.Read)))
	mux.Handle("POST /api/messages/{id}/reactions", authHandler.Middleware(http.HandlerFunc(messageHandler.React)))
	mux.Handle("POST /api/messages/{id}/pin", authHandler.Middleware(http.HandlerFunc(messageHandler.Pin)))
	mux.Handle("PUT /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(messageHandler.Update)))
	mux.Handle("DELETE /api/messages/{id}", authHandler.Middleware(http.HandlerFunc(messageHandler.Delete)))
	mux.Handle("POST /api/files", authHandler.Middleware(http.HandlerFunc(fileHandler.Upload)))
	mux.Handle("GET /api/files/{id}", authHandler.Middleware(http.HandlerFunc(fileHandler.Download)))
	mux.Handle("GET /api/push/vapid-public-key", authHandler.Middleware(http.HandlerFunc(pushHandler.PublicKey)))
	mux.Handle("GET /api/push/status", authHandler.Middleware(http.HandlerFunc(pushHandler.Status)))
	mux.Handle("POST /api/push/subscribe", authHandler.Middleware(http.HandlerFunc(pushHandler.Subscribe)))
	mux.Handle("POST /api/push/unsubscribe", authHandler.Middleware(http.HandlerFunc(pushHandler.Unsubscribe)))
	mux.Handle("POST /api/push/test", authHandler.Middleware(http.HandlerFunc(pushHandler.Test)))
	mux.Handle("GET /api/calls/config", authHandler.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		callConfig, err := editionWebRTCConfig(db, webRTCDefaults)
		if err != nil {
			httpx.Error(w, http.StatusInternalServerError, "settings lookup failed")
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{
			"ice_servers":             callConfig.ICEServers,
			"public_fallback_urls":    callConfig.PublicFallbackURLs,
			"relay_policy":            callConfig.RelayPolicy,
			"private_turn_configured": callConfig.PrivateTURNConfigured,
			"source":                  callConfig.Source,
		})
	})))
	mux.Handle("GET /api/ws", authHandler.Middleware(wsHandler))
	registerFederationRoutes(mux, routeDeps)
	registerEditionRoutes(mux, routeDeps)
	webDir := strings.TrimSpace(os.Getenv("WEB_DIR"))
	if webDir == "" {
		webDir = "web"
	}
	mux.Handle("/", noCacheStatic(http.FileServer(http.Dir(webDir)), webDir))

	policy := newOriginPolicy(cfg.ClientOrigins)
	handler := securityHeaders(cors(originGuard(mux, policy), policy), cfg.SecureCookies)
	server := &http.Server{
		Addr: cfg.Addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second,
	}
	log.Printf("chat-pwa-go listening on http://localhost%s", cfg.Addr)
	startFederationWorkers(routeDeps, federationWorkerConfig{
		BatchSize:     cfg.FederationOutboxBatch,
		PollInterval:  cfg.FederationOutboxEvery,
		WorkerCount:   cfg.FederationOutboxWorkers,
		LockDuration:  2 * time.Minute,
		SentRetention: cfg.FederationOutboxSentRetention,
	})
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func originGuard(next http.Handler, policy originPolicy) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet && r.Method != http.MethodHead {
			origin := r.Header.Get("Origin")
			if origin != "" && !policy.allow(origin, r.Host) {
				httpx.Error(w, http.StatusForbidden, "invalid origin")
				return
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" && !policy.allow(origin, r.Host) {
				httpx.Error(w, http.StatusForbidden, "cross-site request denied")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

type originPolicy struct {
	any     bool
	allowed map[string]bool
}

func newOriginPolicy(origins []string) originPolicy {
	policy := originPolicy{allowed: make(map[string]bool, len(origins))}
	for _, origin := range origins {
		if origin == "*" {
			policy.any = true
			continue
		}
		policy.allowed[strings.TrimRight(origin, "/")] = true
	}
	return policy
}

func (p originPolicy) allow(origin, host string) bool {
	origin = strings.TrimRight(origin, "/")
	return origin == "" || origin == "http://"+host || origin == "https://"+host || p.any || p.allowed[origin]
}

func cors(next http.Handler, policy originPolicy) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && policy.allow(origin, r.Host) {
			w.Header().Set("Access-Control-Allow-Origin", strings.TrimRight(origin, "/"))
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions && strings.HasPrefix(r.URL.Path, "/api/") {
			if origin == "" || !policy.allow(origin, r.Host) {
				httpx.Error(w, http.StatusForbidden, "invalid origin")
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func sameSiteMode(value string) http.SameSite {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "strict":
		return http.SameSiteStrictMode
	case "none":
		return http.SameSiteNoneMode
	default:
		return http.SameSiteLaxMode
	}
}

func securityHeaders(next http.Handler, strictTransport bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'")
		if strictTransport {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

func noCacheStatic(next http.Handler, webDir string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".html") || strings.HasSuffix(r.URL.Path, ".js") ||
			strings.HasSuffix(r.URL.Path, ".css") || r.URL.Path == "/" || r.URL.Path == "/sw.js" {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if _, err := os.Stat(webDir + r.URL.Path); os.IsNotExist(err) && !strings.HasPrefix(r.URL.Path, "/api/") {
			r.URL.Path = "/index.html"
		}
		next.ServeHTTP(w, r)
	})
}
