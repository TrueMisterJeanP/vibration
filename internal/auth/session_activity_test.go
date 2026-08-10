package auth

import (
	"testing"
	"time"
)

func TestSessionActivityWritesAtMostOncePerInterval(t *testing.T) {
	tracker := newSessionActivityTracker(time.Minute)
	base := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	if !tracker.shouldWrite("session-a", "10.0.0.1", base) {
		t.Fatal("the first request must record activity")
	}
	if tracker.shouldWrite("session-a", "10.0.0.1", base.Add(time.Second)) {
		t.Fatal("a request one second later must not write again")
	}
	if tracker.shouldWrite("session-a", "10.0.0.1", base.Add(59*time.Second)) {
		t.Fatal("a request inside the interval must not write again")
	}
	if !tracker.shouldWrite("session-a", "10.0.0.1", base.Add(time.Minute)) {
		t.Fatal("a request past the interval must write again")
	}
}

// A changed client address is security-relevant and is shown in the session
// list, so it must be persisted immediately rather than waiting out the window.
func TestSessionActivityWritesImmediatelyOnAddressChange(t *testing.T) {
	tracker := newSessionActivityTracker(time.Minute)
	base := time.Date(2026, 8, 10, 12, 0, 0, 0, time.UTC)
	tracker.shouldWrite("session-a", "10.0.0.1", base)
	if !tracker.shouldWrite("session-a", "203.0.113.9", base.Add(time.Second)) {
		t.Fatal("a new client address must be recorded without waiting")
	}
	if tracker.shouldWrite("session-a", "203.0.113.9", base.Add(2*time.Second)) {
		t.Fatal("the new address then falls back to the throttled path")
	}
}

func TestSessionActivityIsolatesSessions(t *testing.T) {
	tracker := newSessionActivityTracker(time.Minute)
	now := time.Now()
	if !tracker.shouldWrite("session-a", "10.0.0.1", now) || !tracker.shouldWrite("session-b", "10.0.0.1", now) {
		t.Fatal("each session must be throttled independently")
	}
}

func TestSessionActivityForgetAllowsAnImmediateWrite(t *testing.T) {
	tracker := newSessionActivityTracker(time.Minute)
	now := time.Now()
	tracker.shouldWrite("session-a", "10.0.0.1", now)
	tracker.forget("session-a")
	if !tracker.shouldWrite("session-a", "10.0.0.1", now) {
		t.Fatal("a forgotten session must be recorded again")
	}
}

func TestSessionActivityStaysBounded(t *testing.T) {
	tracker := newSessionActivityTracker(time.Millisecond)
	base := time.Now()
	for index := 0; index < sessionActivityMaxEntries+2000; index++ {
		tracker.shouldWrite(string(rune(index%1000))+"-"+time.Duration(index).String(), "10.0.0.1", base.Add(time.Duration(index)*time.Millisecond))
	}
	tracker.mu.Lock()
	size := len(tracker.entries)
	tracker.mu.Unlock()
	if size > sessionActivityMaxEntries {
		t.Fatalf("tracker grew to %d entries, above the %d bound", size, sessionActivityMaxEntries)
	}
}
