package main

import (
	"crypto/subtle"
	"database/sql"
	"net/http"
	"runtime"
	"strings"
	"time"

	"chat-pwa-go/internal/httpx"
	"chat-pwa-go/internal/ws"
)

// registerMetricsRoute exposes runtime, connection pool and hub counters for
// load testing and operational dashboards. It is disabled unless METRICS_TOKEN
// is set, and always requires that token: the payload describes the server's
// capacity, never user data.
func registerMetricsRoute(mux *http.ServeMux, token string, db *sql.DB, hub *ws.Hub) {
	token = strings.TrimSpace(token)
	if token == "" {
		return
	}
	started := time.Now()
	mux.HandleFunc("GET /api/metrics", func(w http.ResponseWriter, r *http.Request) {
		if !metricsTokenMatches(r, token) {
			httpx.Error(w, http.StatusUnauthorized, "metrics token required")
			return
		}
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		pool := db.Stats()
		hubStats := hub.Stats()
		httpx.JSON(w, http.StatusOK, map[string]any{
			"uptime_seconds": time.Since(started).Seconds(),
			"goroutines":     runtime.NumGoroutine(),
			"memory": map[string]any{
				"heap_alloc_bytes": memory.HeapAlloc,
				"heap_sys_bytes":   memory.HeapSys,
				"sys_bytes":        memory.Sys,
				"num_gc":           memory.NumGC,
			},
			"database_pool": map[string]any{
				"max_open_connections": pool.MaxOpenConnections,
				"open_connections":     pool.OpenConnections,
				"in_use":               pool.InUse,
				"idle":                 pool.Idle,
				"wait_count":           pool.WaitCount,
				"wait_duration_ms":     pool.WaitDuration.Milliseconds(),
				"max_idle_closed":      pool.MaxIdleClosed,
				"max_idle_time_closed": pool.MaxIdleTimeClosed,
				"max_lifetime_closed":  pool.MaxLifetimeClosed,
			},
			"websocket": hubStats,
		})
	})
}

func metricsTokenMatches(r *http.Request, token string) bool {
	presented := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	return subtle.ConstantTimeCompare([]byte(presented), []byte(token)) == 1
}
