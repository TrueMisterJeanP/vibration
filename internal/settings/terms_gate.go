package settings

import (
	"database/sql"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// termsVersionTTL bounds how long a cached terms version is trusted. It only
// matters when several instances share a database: the instance that publishes
// new terms invalidates its cache immediately, the others enforce the new
// version within this delay.
const termsVersionTTL = 15 * time.Second

// termsAcceptanceCacheMax bounds the acceptance cache.
const termsAcceptanceCacheMax = 100_000

// TermsGate answers "may this user call the API?" without hitting the database
// on every request.
//
// The middleware used to run two queries per API call: one reading the whole
// terms text just to obtain its version number, and one acceptance lookup. At a
// thousand connected users that is the single most repeated query pair in the
// system.
//
// Caching is safe in the direction that matters. Acceptance is monotonic for a
// given version, and publishing new terms increments the version, so every
// cached entry becomes insufficient at once and the user is challenged again.
// Only positive results are cached: a user who has not accepted is re-checked
// on each request.
type TermsGate struct {
	mu        sync.RWMutex
	version   int64
	versionAt time.Time
	epoch     uint64
	accepted  map[int64]int64
}

func NewTermsGate() *TermsGate {
	return &TermsGate{accepted: make(map[int64]int64)}
}

// termsEpoch is bumped whenever this process publishes new terms. Gates are
// per-handler so that two handlers backed by different databases (as in tests)
// never share acceptance state, but they all observe the epoch and drop their
// cached version when it moves.
var termsEpoch atomic.Uint64

// Invalidate drops the cached version, so a terms update takes effect
// immediately on the instance that applied it.
func (g *TermsGate) Invalidate() {
	if g == nil {
		return
	}
	g.mu.Lock()
	g.versionAt = time.Time{}
	g.mu.Unlock()
}

// InvalidateTerms tells every gate in this process that the terms version
// changed, so a publication through the admin panel is enforced immediately
// instead of after the cache TTL.
func InvalidateTerms() { termsEpoch.Add(1) }

// Accepted reports whether the user accepted the current terms, and returns
// that version so callers can report it.
func (g *TermsGate) Accepted(db *sql.DB, userID int64) (bool, int64, error) {
	version, err := g.currentVersion(db)
	if err != nil {
		return false, 0, err
	}
	if g.cachedAcceptance(userID) >= version {
		return true, version, nil
	}
	accepted, err := TermsAccepted(db, userID, version)
	if err != nil {
		return false, version, err
	}
	if accepted {
		g.rememberAcceptance(userID, version)
	}
	return accepted, version, nil
}

// Remember records an acceptance that this instance just persisted.
func (g *TermsGate) Remember(userID, version int64) {
	if g == nil {
		return
	}
	g.rememberAcceptance(userID, version)
}

func (g *TermsGate) currentVersion(db *sql.DB) (int64, error) {
	now := time.Now()
	epoch := termsEpoch.Load()
	g.mu.RLock()
	version, at, cachedEpoch := g.version, g.versionAt, g.epoch
	g.mu.RUnlock()
	if !at.IsZero() && cachedEpoch == epoch && now.Sub(at) < termsVersionTTL {
		return version, nil
	}
	version, err := TermsVersion(db)
	if err != nil {
		return 0, err
	}
	g.mu.Lock()
	g.version, g.versionAt, g.epoch = version, now, epoch
	g.mu.Unlock()
	return version, nil
}

func (g *TermsGate) cachedAcceptance(userID int64) int64 {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.accepted[userID]
}

func (g *TermsGate) rememberAcceptance(userID, version int64) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.accepted == nil {
		g.accepted = make(map[int64]int64)
	}
	if len(g.accepted) >= termsAcceptanceCacheMax {
		g.accepted = make(map[int64]int64)
	}
	if version > g.accepted[userID] {
		g.accepted[userID] = version
	}
}

// TermsVersion reads only the version key. LoadTerms also fetches the full
// terms text, which is pointless on a request path that just needs the number.
func TermsVersion(db *sql.DB) (int64, error) {
	var raw string
	err := db.QueryRow("SELECT value FROM app_settings WHERE `key`=?", TermsVersionKey).Scan(&raw)
	if err == sql.ErrNoRows {
		return 1, nil
	}
	if err != nil {
		return 0, err
	}
	if parsed, parseErr := strconv.ParseInt(raw, 10, 64); parseErr == nil && parsed > 0 {
		return parsed, nil
	}
	return 1, nil
}
