package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
}
