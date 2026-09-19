package requestguard

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestNotFoundGuardBlocksThirdMissForTenMinutes(t *testing.T) {
	now := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	guard := NewNotFoundGuard(3, 10*time.Minute, 10*time.Minute, func(_ *http.Request) (netip.Addr, error) {
		return netip.MustParseAddr("203.0.113.8"), nil
	})
	guard.now = func() time.Time { return now }
	request := httptest.NewRequest("GET", "/missing", nil)

	for attempt := 1; attempt <= 2; attempt++ {
		if decision := guard.RecordMiss(request); decision.Blocked {
			t.Fatalf("attempt %d was blocked too early", attempt)
		}
	}
	decision := guard.RecordMiss(request)
	if !decision.Blocked || !decision.NewlyBlocked {
		t.Fatalf("third miss decision=%+v", decision)
	}
	if decision.RetryAfter != 10*time.Minute {
		t.Fatalf("RetryAfter=%s", decision.RetryAfter)
	}

	now = now.Add(9*time.Minute + 59*time.Second)
	if decision := guard.Check(request); !decision.Blocked {
		t.Fatal("block expired too early")
	}
	now = now.Add(time.Second)
	if decision := guard.Check(request); decision.Blocked {
		t.Fatal("block did not expire after ten minutes")
	}
}

func TestNotFoundGuardExpiresOldMisses(t *testing.T) {
	now := time.Date(2026, time.September, 19, 12, 0, 0, 0, time.UTC)
	guard := NewNotFoundGuard(3, 10*time.Minute, 10*time.Minute, func(_ *http.Request) (netip.Addr, error) {
		return netip.MustParseAddr("2001:db8::10"), nil
	})
	guard.now = func() time.Time { return now }
	request := httptest.NewRequest("GET", "/missing", nil)

	guard.RecordMiss(request)
	guard.RecordMiss(request)
	now = now.Add(10 * time.Minute)
	if decision := guard.RecordMiss(request); decision.Blocked {
		t.Fatal("expired misses were incorrectly retained")
	}
}

func TestNotFoundGuardSeparatesClientAddresses(t *testing.T) {
	guard := NewNotFoundGuard(3, 10*time.Minute, 10*time.Minute, func(r *http.Request) (netip.Addr, error) {
		return netip.ParseAddr(r.Header.Get("X-Test-IP"))
	})
	first := httptest.NewRequest("GET", "/missing", nil)
	first.Header.Set("X-Test-IP", "192.0.2.10")
	second := httptest.NewRequest("GET", "/missing", nil)
	second.Header.Set("X-Test-IP", "192.0.2.11")

	guard.RecordMiss(first)
	guard.RecordMiss(first)
	guard.RecordMiss(second)
	if decision := guard.Check(second); decision.Blocked {
		t.Fatal("one client's misses blocked another client")
	}
}
