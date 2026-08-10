//go:build !community

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chat-pwa-go/internal/config"
	database "chat-pwa-go/internal/db"
	"chat-pwa-go/internal/ws"
)

// A stale data/database_config.json must never downgrade a MariaDB deployment
// to the local SQLite file: the server would look healthy while serving an
// empty, unreplicated database.
func TestStartupRefusesSQLiteWhenMariaDBIsConfigured(t *testing.T) {
	cfg := config.Config{DatabaseDriver: "mariadb", DatabaseConfigPath: "/var/lib/vibration/database_config.json"}
	err := guardSQLiteFallback(cfg, database.ActiveConfig{Driver: "sqlite"})
	if err == nil {
		t.Fatal("the server must refuse to start on sqlite while an external database is configured")
	}
	for _, fragment := range []string{"mariadb", "sqlite", "DATABASE_ALLOW_SQLITE_OVERRIDE"} {
		if !strings.Contains(err.Error(), fragment) {
			t.Fatalf("error %q does not mention %q", err, fragment)
		}
	}
}

func TestStartupAcceptsSQLiteWhenExplicitlyAllowed(t *testing.T) {
	cfg := config.Config{DatabaseDriver: "mariadb", DatabaseAllowSQLiteOverride: true}
	if err := guardSQLiteFallback(cfg, database.ActiveConfig{Driver: "sqlite"}); err != nil {
		t.Fatalf("the explicit override must be honoured: %v", err)
	}
}

func TestStartupAcceptsMatchingConfigurations(t *testing.T) {
	tests := []struct {
		name    string
		env     string
		active  string
		wantErr bool
	}{
		{name: "sqlite everywhere", env: "sqlite", active: "sqlite"},
		{name: "no driver configured", env: "", active: "sqlite"},
		{name: "mariadb everywhere", env: "mariadb", active: "mysql"},
		{name: "postgres selected while env says mariadb", env: "mariadb", active: "postgres"},
		{name: "mariadb env with sqlite selected", env: "mariadb", active: "sqlite", wantErr: true},
		{name: "postgres env with sqlite selected", env: "postgres", active: "sqlite", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cfg := config.Config{DatabaseDriver: test.env}
			err := guardSQLiteFallback(cfg, database.ActiveConfig{Driver: test.active})
			if test.wantErr != (err != nil) {
				t.Fatalf("guardSQLiteFallback err=%v, wantErr=%v", err, test.wantErr)
			}
		})
	}
}

// The metrics route exposes capacity information, so it stays off unless a
// token is configured and must reject every request that does not present it.
func TestMetricsRouteIsDisabledWithoutAToken(t *testing.T) {
	mux := http.NewServeMux()
	registerMetricsRoute(mux, "", nil, ws.NewHub())
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/metrics", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("metrics status=%d without METRICS_TOKEN, want 404", recorder.Code)
	}
}

func TestMetricsRouteRequiresTheToken(t *testing.T) {
	mux := http.NewServeMux()
	registerMetricsRoute(mux, "s3cret-token", nil, ws.NewHub())
	for _, test := range []struct {
		name   string
		header string
		want   int
	}{
		{name: "no header", header: "", want: http.StatusUnauthorized},
		{name: "wrong token", header: "Bearer nope", want: http.StatusUnauthorized},
		{name: "token without prefix", header: "s3cret-token", want: http.StatusOK},
		{name: "bearer token", header: "Bearer s3cret-token", want: http.StatusOK},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/metrics", nil)
			if test.header != "" {
				request.Header.Set("Authorization", test.header)
			}
			recorder := httptest.NewRecorder()
			// A nil *sql.DB would panic on Stats(), so only the rejected cases
			// reach the handler body; the accepted ones are checked separately.
			if test.want == http.StatusOK {
				if !metricsTokenMatches(request, "s3cret-token") {
					t.Fatal("the token should have been accepted")
				}
				return
			}
			mux.ServeHTTP(recorder, request)
			if recorder.Code != test.want {
				t.Fatalf("metrics status=%d, want %d", recorder.Code, test.want)
			}
		})
	}
}
