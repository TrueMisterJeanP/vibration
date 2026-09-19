package main

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"chat-pwa-go/internal/requestguard"
)

func TestOriginPolicyRejectsWildcardAndAllowsExplicitOrigin(t *testing.T) {
	policy := newOriginPolicy([]string{"*", "https://client.example.com/"})
	if policy.allow("https://attacker.example", "server.example") {
		t.Fatal("wildcard origin unexpectedly allowed")
	}
	if !policy.allow("https://client.example.com", "server.example") {
		t.Fatal("explicit origin unexpectedly rejected")
	}
}

func TestSecurityHeadersDisableAPICaching(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), false)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/me", nil))

	if value := response.Header().Get("Cache-Control"); value != "no-store" {
		t.Fatalf("Cache-Control=%q", value)
	}
	if value := response.Header().Get("Pragma"); value != "no-cache" {
		t.Fatalf("Pragma=%q", value)
	}
}

func TestSecurityHeadersKeepStaticAssetCachingAvailable(t *testing.T) {
	handler := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), false)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/icons/icon-192.png", nil))

	if value := response.Header().Get("Cache-Control"); value != "" {
		t.Fatalf("static Cache-Control=%q", value)
	}
	if value := response.Header().Get("Content-Security-Policy"); !strings.Contains(value, "object-src 'self' blob:") {
		t.Fatalf("PDF object preview is blocked by CSP: %q", value)
	}
}

func TestLoadErrorPageUsesEmbeddedBrandedFallback(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusTooManyRequests} {
		page := loadErrorPage(filepath.Join(t.TempDir(), "missing.html"), status)
		if page.status != status {
			t.Fatalf("status=%d, want %d", page.status, status)
		}
		body := string(page.body)
		if !strings.Contains(body, "Vibration") || !strings.Contains(body, "background: #ffffff") {
			t.Fatalf("status %d did not use branded embedded page", status)
		}
	}
}

func TestErrorPagesSupportEveryApplicationLanguage(t *testing.T) {
	tests := []struct {
		language string
		status   int
		want     string
	}{
		{language: "fr", status: http.StatusNotFound, want: "Page introuvable"},
		{language: "en", status: http.StatusNotFound, want: "Page not found"},
		{language: "es", status: http.StatusNotFound, want: "Página no encontrada"},
		{language: "it", status: http.StatusTooManyRequests, want: "Troppe richieste"},
		{language: "pt", status: http.StatusTooManyRequests, want: "Demasiados pedidos"},
		{language: "de", status: http.StatusTooManyRequests, want: "Zu viele Anfragen"},
	}

	for _, test := range tests {
		t.Run(test.language+"/"+strconv.Itoa(test.status), func(t *testing.T) {
			page := loadErrorPage(filepath.Join(t.TempDir(), "missing.html"), test.status)
			request := httptest.NewRequest(http.MethodGet, "/missing", nil)
			request.Header.Set("Accept-Language", test.language+"-XX,"+test.language+";q=0.9")
			response := httptest.NewRecorder()
			page.ServeHTTP(response, request)

			if response.Code != test.status {
				t.Fatalf("status=%d, want %d", response.Code, test.status)
			}
			if got := response.Header().Get("Content-Language"); got != test.language {
				t.Fatalf("Content-Language=%q, want %q", got, test.language)
			}
			if !strings.Contains(response.Header().Get("Vary"), "Accept-Language") {
				t.Fatalf("Vary=%q", response.Header().Get("Vary"))
			}
			body := response.Body.String()
			if !strings.Contains(body, `<html lang="`+test.language+`">`) || !strings.Contains(body, test.want) {
				t.Fatalf("language %s was not rendered: %q", test.language, body)
			}
		})
	}
}

func TestPreferredErrorLanguageHonoursQualityAndFallsBackToFrench(t *testing.T) {
	if got := preferredErrorLanguage("nl-NL,de-DE;q=0.7,en-GB;q=0.9"); got != "en" {
		t.Fatalf("preferred language=%q, want en", got)
	}
	if got := preferredErrorLanguage("nl-NL,*;q=0.5"); got != "fr" {
		t.Fatalf("fallback language=%q, want fr", got)
	}
	if got := preferredErrorLanguage("en;q=0,de;q=0.8"); got != "de" {
		t.Fatalf("zero-quality language selected: %q", got)
	}
}

func TestUnknownStaticPathsRateLimitThirdAttemptAndBlockValidPaths(t *testing.T) {
	webDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte("home"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(webDir, "sw.js"), []byte("worker"), 0o600); err != nil {
		t.Fatal(err)
	}
	guard := testNotFoundGuard()
	notFoundPage := errorPage{status: http.StatusNotFound, body: []byte("custom 404")}
	blockedPage := errorPage{status: http.StatusTooManyRequests, body: []byte("custom 429")}
	files := http.Dir(webDir)
	handler := noCacheStatic(http.FileServer(files), files, guard, nil, notFoundPage, blockedPage)

	for attempt := 1; attempt <= 2; attempt++ {
		response := serveFromIP(handler, "/public/public.php?rest_route=/wp/v2/tags", "203.0.113.20:4567")
		if response.Code != http.StatusNotFound || response.Body.String() != "custom 404" {
			t.Fatalf("attempt %d: status=%d body=%q", attempt, response.Code, response.Body.String())
		}
	}
	third := serveFromIP(handler, "/wp-json/batch/v1", "203.0.113.20:4567")
	if third.Code != http.StatusTooManyRequests || third.Header().Get("Retry-After") != "600" {
		t.Fatalf("third attempt: status=%d Retry-After=%q", third.Code, third.Header().Get("Retry-After"))
	}
	// A different source port represents a separate browser connection. The
	// address-based block must still return 429, even for a valid page.
	valid := serveFromIP(handler, "/", "203.0.113.20:9876")
	if valid.Code != http.StatusTooManyRequests || valid.Body.String() != "custom 429" {
		t.Fatalf("blocked client reached valid path from another browser: status=%d body=%q", valid.Code, valid.Body.String())
	}
	directWorker := serveFromIP(handler, "/sw.js", "203.0.113.20:9876")
	if directWorker.Code != http.StatusTooManyRequests {
		t.Fatalf("direct service worker visit bypassed block: status=%d", directWorker.Code)
	}
	workerUpdateRequest := httptest.NewRequest(http.MethodGet, "/sw.js?v=rate-limit-page-v463", nil)
	workerUpdateRequest.RemoteAddr = "203.0.113.20:9876"
	workerUpdateRequest.Header.Set("Service-Worker", "script")
	workerUpdate := httptest.NewRecorder()
	handler.ServeHTTP(workerUpdate, workerUpdateRequest)
	if workerUpdate.Code != http.StatusOK || workerUpdate.Body.String() != "worker" {
		t.Fatalf("service worker could not update during block: status=%d body=%q", workerUpdate.Code, workerUpdate.Body.String())
	}
	fourth := serveFromIP(handler, "/another-missing-path", "203.0.113.20:4567")
	if fourth.Code != http.StatusTooManyRequests {
		t.Fatalf("fourth unknown path: status=%d", fourth.Code)
	}
}

func TestApplicationLevelNotFoundDoesNotCountAsUnknownURL(t *testing.T) {
	webDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte("home"), 0o600); err != nil {
		t.Fatal(err)
	}
	guard := testNotFoundGuard()
	notFoundPage := errorPage{status: http.StatusNotFound, body: []byte("custom 404")}
	blockedPage := errorPage{status: http.StatusTooManyRequests, body: []byte("custom 429")}
	files := http.Dir(webDir)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/objects/{id}", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "object not found", http.StatusNotFound)
	})
	mux.Handle("/", noCacheStatic(http.FileServer(files), files, guard, nil, notFoundPage, blockedPage))
	handler := mux

	for attempt := 0; attempt < 3; attempt++ {
		response := serveFromIP(handler, "/api/objects/999", "198.51.100.8:8080")
		if response.Code != http.StatusNotFound {
			t.Fatalf("API response status=%d", response.Code)
		}
	}
	valid := serveFromIP(handler, "/", "198.51.100.8:8080")
	if valid.Code != http.StatusOK || valid.Body.String() != "home" {
		t.Fatalf("legitimate API 404s caused a block: status=%d body=%q", valid.Code, valid.Body.String())
	}
}

func TestIdentifiedUserNeverReceivesUnknownURLRateLimit(t *testing.T) {
	webDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte("home"), 0o600); err != nil {
		t.Fatal(err)
	}
	guard := testNotFoundGuard()
	notFoundPage := errorPage{status: http.StatusNotFound, body: []byte("custom 404")}
	blockedPage := errorPage{status: http.StatusTooManyRequests, body: []byte("custom 429")}
	files := http.Dir(webDir)
	identified := func(r *http.Request) bool { return r.Header.Get("X-Test-Identified") == "yes" }
	handler := noCacheStatic(http.FileServer(files), files, guard, identified, notFoundPage, blockedPage)

	// First block the address anonymously.
	for attempt := 0; attempt < 3; attempt++ {
		serveFromIP(handler, "/anonymous-missing", "203.0.113.30:4000")
	}
	request := httptest.NewRequest(http.MethodGet, "/identified-missing", nil)
	request.RemoteAddr = "203.0.113.30:9000"
	request.Header.Set("X-Test-Identified", "yes")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || response.Body.String() != "custom 404" {
		t.Fatalf("identified blocked-IP request: status=%d body=%q", response.Code, response.Body.String())
	}
	request = httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "203.0.113.30:9000"
	request.Header.Set("X-Test-Identified", "yes")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.String() != "home" {
		t.Fatalf("identified user could not bypass blocked IP: status=%d body=%q", response.Code, response.Body.String())
	}

	// Identified misses on a fresh address must not create anonymous strikes.
	for attempt := 0; attempt < 3; attempt++ {
		request = httptest.NewRequest(http.MethodGet, "/identified-missing", nil)
		request.RemoteAddr = "198.51.100.30:9000"
		request.Header.Set("X-Test-Identified", "yes")
		response = httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("identified attempt %d: status=%d", attempt+1, response.Code)
		}
	}
	anonymous := serveFromIP(handler, "/anonymous-after-identified", "198.51.100.30:4000")
	if anonymous.Code != http.StatusNotFound {
		t.Fatalf("identified misses counted as strikes: status=%d", anonymous.Code)
	}
}

func testNotFoundGuard() *requestguard.NotFoundGuard {
	return requestguard.NewNotFoundGuard(3, 10*time.Minute, 10*time.Minute, func(r *http.Request) (netip.Addr, error) {
		address, _, _ := strings.Cut(r.RemoteAddr, ":")
		return netip.ParseAddr(address)
	})
}

func serveFromIP(handler http.Handler, target, remoteAddress string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.RemoteAddr = remoteAddress
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
