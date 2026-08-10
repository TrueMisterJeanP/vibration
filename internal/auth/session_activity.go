package auth

import (
	"sync"
	"time"
)

// sessionActivityInterval is the minimum delay between two `last_seen_at`
// writes for the same session. Session listings show activity with a minute
// granularity, so writing more often only costs write amplification: at 1000
// connected users polling a handful of endpoints, the previous
// write-on-every-request behaviour produced thousands of row updates per second
// against a single hot table.
const sessionActivityInterval = time.Minute

// sessionActivityMaxEntries bounds the tracker so a long-lived process cannot
// accumulate one entry per session seen since boot.
const sessionActivityMaxEntries = 50_000

type sessionActivityState struct {
	writtenAt time.Time
	address   string
}

// sessionActivityTracker throttles session activity writes per process.
//
// It is deliberately instance-local. Each instance therefore writes at most
// once per interval per session it serves, which keeps the write rate bounded
// on every topology. Correctness is preserved across instances because the
// value written is always `time.Now()` at write time, never a cached
// timestamp: concurrent instances can only ever push `last_seen_at` forward.
// Nothing else reads this cache, so expiry, banning, revocation and approval
// keep querying the database on every single request.
type sessionActivityTracker struct {
	mu       sync.Mutex
	interval time.Duration
	entries  map[string]sessionActivityState
}

func newSessionActivityTracker(interval time.Duration) *sessionActivityTracker {
	if interval <= 0 {
		interval = sessionActivityInterval
	}
	return &sessionActivityTracker{interval: interval, entries: make(map[string]sessionActivityState)}
}

// shouldWrite reports whether the session activity row must be refreshed.
// A write happens when the throttling interval elapsed, or as soon as the
// client address changes so the security-relevant IP shown in session listings
// stays accurate.
func (t *sessionActivityTracker) shouldWrite(sessionID, address string, now time.Time) bool {
	if t == nil || sessionID == "" {
		return true
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	previous, known := t.entries[sessionID]
	if known && previous.address == address && now.Sub(previous.writtenAt) < t.interval {
		return false
	}
	if len(t.entries) >= sessionActivityMaxEntries {
		t.evictExpiredLocked(now)
	}
	t.entries[sessionID] = sessionActivityState{writtenAt: now, address: address}
	return true
}

// forget drops a session, so a revoked or logged-out session does not keep an
// entry alive and a new session reusing the slot starts from a clean state.
func (t *sessionActivityTracker) forget(sessionID string) {
	if t == nil || sessionID == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, sessionID)
}

// evictExpiredLocked removes entries past the throttling window. Dropping an
// entry is always safe: the next request simply performs one extra write.
func (t *sessionActivityTracker) evictExpiredLocked(now time.Time) {
	for id, state := range t.entries {
		if now.Sub(state.writtenAt) >= t.interval {
			delete(t.entries, id)
		}
	}
	if len(t.entries) < sessionActivityMaxEntries {
		return
	}
	// Every entry is still within its window; drop the whole map rather than
	// grow without bound.
	t.entries = make(map[string]sessionActivityState)
}

// sessionActivity lazily builds the tracker so a zero-value Handler (used in
// tests and by the community edition) keeps working.
func (h *Handler) sessionActivity() *sessionActivityTracker {
	h.activityOnce.Do(func() {
		interval := h.SessionActivityInterval
		if interval == 0 {
			interval = sessionActivityInterval
		}
		h.activity = newSessionActivityTracker(interval)
	})
	return h.activity
}

// touchSession refreshes `last_seen_at` and `ip_address`, at most once per
// interval per session and per instance.
func (h *Handler) touchSession(sessionID, address string) {
	now := time.Now().UTC()
	if !h.sessionActivity().shouldWrite(sessionID, address, now) {
		return
	}
	_, _ = h.DB.Exec(`UPDATE sessions SET last_seen_at=?,ip_address=? WHERE id=?`,
		now.Format(time.RFC3339Nano), address, sessionID)
}
