package requestguard

import (
	"net/http"
	"net/netip"
	"sync"
	"time"
)

const (
	maxTrackedClients = 100_000
	cleanupInterval   = time.Minute
)

// ClientIPFunc returns the effective client address after applying the
// deployment's trusted-proxy policy.
type ClientIPFunc func(*http.Request) (netip.Addr, error)

// Decision describes whether a client is currently blocked. NewlyBlocked is
// true only for the missing request that reached the configured threshold.
type Decision struct {
	ClientIP     netip.Addr
	Blocked      bool
	NewlyBlocked bool
	RetryAfter   time.Duration
}

type clientState struct {
	misses       int
	windowEndsAt time.Time
	blockedUntil time.Time
}

// NotFoundGuard temporarily blocks clients that repeatedly request paths that
// do not exist. It deliberately tracks routing misses only: a legitimate API
// response such as "conversation not found" must never count as a strike.
type NotFoundGuard struct {
	mu            sync.Mutex
	threshold     int
	window        time.Duration
	blockDuration time.Duration
	clientIP      ClientIPFunc
	clients       map[netip.Addr]clientState
	lastCleanup   time.Time
	now           func() time.Time
}

func NewNotFoundGuard(threshold int, window, blockDuration time.Duration, clientIP ClientIPFunc) *NotFoundGuard {
	return &NotFoundGuard{
		threshold:     threshold,
		window:        window,
		blockDuration: blockDuration,
		clientIP:      clientIP,
		clients:       make(map[netip.Addr]clientState),
		now:           time.Now,
	}
}

// Check reports an existing block without adding a strike.
func (g *NotFoundGuard) Check(r *http.Request) Decision {
	address, ok := g.address(r)
	if !ok || !g.enabled() {
		return Decision{}
	}
	now := g.now()
	g.mu.Lock()
	defer g.mu.Unlock()
	state, exists := g.clients[address]
	if !exists {
		return Decision{ClientIP: address}
	}
	state, active := normalizeState(state, now)
	if !active {
		delete(g.clients, address)
		return Decision{ClientIP: address}
	}
	g.clients[address] = state
	return decisionFor(address, state, now, false)
}

// RecordMiss adds one routing miss and starts a block as soon as the threshold
// is reached. Misses expire after the observation window.
func (g *NotFoundGuard) RecordMiss(r *http.Request) Decision {
	address, ok := g.address(r)
	if !ok || !g.enabled() {
		return Decision{}
	}
	now := g.now()
	g.mu.Lock()
	defer g.mu.Unlock()

	g.cleanup(now)
	stored, tracked := g.clients[address]
	state, active := normalizeState(stored, now)
	if tracked && !active {
		delete(g.clients, address)
	}
	if now.Before(state.blockedUntil) {
		return decisionFor(address, state, now, false)
	}
	// Bound memory under a distributed scan. At capacity, existing clients are
	// still enforced while previously unseen addresses simply receive the 404.
	if !active && len(g.clients) >= maxTrackedClients {
		return Decision{ClientIP: address}
	}
	if state.windowEndsAt.IsZero() {
		state.windowEndsAt = now.Add(g.window)
	}
	state.misses++
	newlyBlocked := false
	if state.misses >= g.threshold {
		state.blockedUntil = now.Add(g.blockDuration)
		newlyBlocked = true
	}
	g.clients[address] = state
	return decisionFor(address, state, now, newlyBlocked)
}

func (g *NotFoundGuard) enabled() bool {
	return g != nil && g.threshold > 0 && g.window > 0 && g.blockDuration > 0 && g.clientIP != nil
}

func (g *NotFoundGuard) address(r *http.Request) (netip.Addr, bool) {
	if g == nil || g.clientIP == nil || r == nil {
		return netip.Addr{}, false
	}
	address, err := g.clientIP(r)
	if err != nil || !address.IsValid() {
		return netip.Addr{}, false
	}
	return address.Unmap(), true
}

func (g *NotFoundGuard) cleanup(now time.Time) {
	if !g.lastCleanup.IsZero() && now.Sub(g.lastCleanup) < cleanupInterval {
		return
	}
	g.lastCleanup = now
	for address, state := range g.clients {
		if normalized, active := normalizeState(state, now); active {
			g.clients[address] = normalized
		} else {
			delete(g.clients, address)
		}
	}
}

func normalizeState(state clientState, now time.Time) (clientState, bool) {
	if !state.blockedUntil.IsZero() {
		if now.Before(state.blockedUntil) {
			return state, true
		}
		return clientState{}, false
	}
	if state.windowEndsAt.IsZero() || !now.Before(state.windowEndsAt) {
		return clientState{}, false
	}
	return state, true
}

func decisionFor(address netip.Addr, state clientState, now time.Time, newlyBlocked bool) Decision {
	if state.blockedUntil.IsZero() || !now.Before(state.blockedUntil) {
		return Decision{ClientIP: address}
	}
	return Decision{
		ClientIP:     address,
		Blocked:      true,
		NewlyBlocked: newlyBlocked,
		RetryAfter:   state.blockedUntil.Sub(now),
	}
}
