package auth

import (
	"testing"
	"time"
)

func TestRateLimiterBlocksAfterLimit(t *testing.T) {
	limiter := NewRateLimiter(2, time.Minute)
	if !limiter.Allow("login:127.0.0.1:user") {
		t.Fatal("first attempt was blocked")
	}
	if !limiter.Allow("login:127.0.0.1:user") {
		t.Fatal("second attempt was blocked")
	}
	if limiter.Allow("login:127.0.0.1:user") {
		t.Fatal("third attempt was allowed")
	}
}

func TestNilRateLimiterAllowsAttempts(t *testing.T) {
	var limiter *RateLimiter
	if !limiter.Allow("login:127.0.0.1:user") {
		t.Fatal("nil limiter blocked an attempt")
	}
}
