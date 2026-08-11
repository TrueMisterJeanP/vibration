package callsig

import (
	"sort"
	"strconv"
	"sync"
	"time"
)

// ReasonInProgress is returned to a peer whose retry arrived while the first
// attempt at the same event was still being processed.
//
// It is deliberately neither a success nor a failure: the first attempt may
// well be about to succeed, so reporting a failure to the calling browser would
// be a guess, and reporting a success would hide a signal that never arrived.
// The sender polls again for the recorded outcome instead.
const ReasonInProgress = "delivery_in_progress"

// ReasonCacheFull is returned when no idempotency slot could be claimed because
// every tracked delivery is still running. Dropping a slot silently could
// deliver the same offer twice, so the request is refused instead.
const ReasonCacheFull = "receipt_cache_full"

const (
	// ReceiptCacheCapacity is a hard ceiling, not a target: the cache never
	// holds more entries than this, even when nothing has expired.
	ReceiptCacheCapacity = 4096
	// receiptFollowerWait is how long a duplicate request waits for the first
	// attempt to publish its outcome. Delivery is a local queue push, so this
	// is a safety valve rather than a normal path.
	receiptFollowerWait = 2 * time.Second
	// receiptSweepInterval prevents a full cache scan for every signal in a
	// burst. The requested key is still checked on every Begin/Lookup, and a
	// full sweep is forced at capacity, so expiry and the hard ceiling remain
	// exact.
	receiptSweepInterval = time.Second
)

// ReceiptKey scopes an idempotency record.
//
// The event id alone is not a safe key: it is chosen by the sender, so two
// instances — or two senders on one instance — can pick the same one, and a
// collision would make one call replay another call's outcome. The key
// therefore includes everything that has already been authenticated by the time
// it is built: the signing instance, the resolved local conversation and the
// sender's canonical identity.
type ReceiptKey struct {
	InstanceID     int64
	ConversationID int64
	Sender         string
	EventID        string
}

func (k ReceiptKey) String() string {
	return strconv.FormatInt(k.InstanceID, 10) + "\x1f" +
		strconv.FormatInt(k.ConversationID, 10) + "\x1f" + k.Sender + "\x1f" + k.EventID
}

type receiptEntry struct {
	done      chan struct{}
	receipt   Receipt
	completed bool
	claimedAt time.Time
	expiresAt time.Time
	// generation distinguishes successive claims of the same key. A leader that
	// expired and was replaced must not be able to publish its stale outcome
	// into the generation that took its place.
	generation uint64
}

// Claim is a leader's handle on one entry. Publish and Abandon take it rather
// than a bare key, so an expired leader cannot overwrite its successor.
type Claim struct {
	key        ReceiptKey
	generation uint64
}

// ReceiptCache makes federated delivery idempotent by outcome, not merely by
// identifier.
//
// Remembering that an event id was seen is not enough: a retry that follows a
// timed-out first attempt must learn what actually happened. If the first
// attempt found the recipient offline, the retry has to be told the recipient
// is offline — not that the event was "already delivered". The cache therefore
// stores the exact Receipt the first attempt produced, and replays it.
type ReceiptCache struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]*receiptEntry
	// wait is how long a follower blocks on the leader; injected for tests.
	wait time.Duration
	// capacity is the hard ceiling on tracked entries.
	capacity int
	// generations increments on every claim, so no two claims of one key — or
	// of two different keys — ever share a handle.
	generations uint64
	sweptAt     time.Time
}

// NewReceiptCache builds a cache using the wall clock.
func NewReceiptCache() *ReceiptCache { return NewReceiptCacheWithClock(time.Now) }

// NewReceiptCacheWithClock builds a cache with an injected clock, for tests.
func NewReceiptCacheWithClock(now func() time.Time) *ReceiptCache {
	return &ReceiptCache{
		now: now, entries: map[string]*receiptEntry{},
		wait: receiptFollowerWait, capacity: ReceiptCacheCapacity,
	}
}

// SetFollowerWait overrides how long a duplicate waits for the first attempt.
func (c *ReceiptCache) SetFollowerWait(wait time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.wait = wait
}

// SetCapacity overrides the hard ceiling, for tests.
func (c *ReceiptCache) SetCapacity(capacity int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.capacity = capacity
}

// Size reports how many outcomes are currently tracked.
func (c *ReceiptCache) Size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// ReceiptRetention is how long an outcome has to stay replayable.
//
// It must cover the whole window during which the same event can still arrive:
// until the event's own expiry, plus the clock skew tolerated at the boundary,
// plus however long the sender may spend retrying it. A fixed duration shorter
// than the protocol's maximum TTL would let a long-lived event outlive the
// record of its own delivery and be delivered twice.
func ReceiptRetention(event Event, now time.Time, retryBudget time.Duration) time.Duration {
	remaining := time.Duration(0)
	if expiresAt, err := ParseTime(event.ExpiresAt); err == nil {
		remaining = expiresAt.Sub(now)
	}
	if remaining < 0 {
		remaining = 0
	}
	if remaining > MaxTTL {
		remaining = MaxTTL
	}
	return remaining + MaxClockSkew + retryBudget
}

// Begin claims an event.
//
// The first caller becomes the leader and must eventually call Publish or
// Abandon. Any concurrent or later caller is a follower: it receives the
// leader's outcome, waiting briefly if the leader has not finished yet, and
// must not perform a delivery of its own. When no slot can be claimed the
// caller is neither leader nor follower and receives ReasonCacheFull.
func (c *ReceiptCache) Begin(key ReceiptKey, retain time.Duration) (leader bool, claim Claim, receipt Receipt) {
	id := key.String()
	now := c.now()
	c.mu.Lock()
	c.expireKey(id, now)
	if now.Sub(c.sweptAt) >= receiptSweepInterval || len(c.entries) >= c.capacity {
		c.sweep(now)
	}
	if entry, known := c.entries[id]; known && now.Before(entry.expiresAt) {
		c.mu.Unlock()
		return false, Claim{}, c.await(entry)
	}
	if len(c.entries) >= c.capacity && !c.evictOne(now) {
		// Every slot holds a delivery that is still running. Evicting one could
		// let its retry deliver a second copy, so the claim is refused instead.
		c.mu.Unlock()
		return false, Claim{}, Receipt{Reason: ReasonCacheFull}
	}
	c.generations++
	generation := c.generations
	c.entries[id] = &receiptEntry{
		done: make(chan struct{}), claimedAt: now,
		expiresAt: now.Add(retain), generation: generation,
	}
	c.mu.Unlock()
	return true, Claim{key: key, generation: generation}, Receipt{}
}

// Lookup reports a recorded or in-flight outcome without claiming anything.
//
// It exists so the receiving side can replay a known result *before* it
// re-resolves membership. Those resolutions depend on state that changes: a
// participant who has since left would otherwise turn an honest retry into
// "unknown_target", contradicting the receipt the first attempt published.
func (c *ReceiptCache) Lookup(key ReceiptKey) (found bool, receipt Receipt) {
	id := key.String()
	now := c.now()
	c.mu.Lock()
	c.expireKey(id, now)
	entry, known := c.entries[id]
	if !known {
		c.mu.Unlock()
		return false, Receipt{}
	}
	c.mu.Unlock()
	return true, c.await(entry)
}

// await returns a finished entry's receipt, waiting briefly for one that is
// still running.
func (c *ReceiptCache) await(entry *receiptEntry) Receipt {
	c.mu.Lock()
	wait := c.wait
	c.mu.Unlock()
	select {
	case <-entry.done:
		c.mu.Lock()
		result := entry.receipt
		c.mu.Unlock()
		return result
	case <-time.After(wait):
		// The leader is still working. Answering "in progress" is the only
		// honest response; the sender polls again for the final outcome.
		return Receipt{Reason: ReasonInProgress}
	}
}

// Publish records the outcome of the leader's delivery and releases followers.
//
// A claim whose generation no longer matches is ignored: its entry expired and
// was replaced, and writing a stale outcome into the new generation would make
// a fresh delivery report a result that was never about it.
func (c *ReceiptCache) Publish(claim Claim, receipt Receipt) {
	c.mu.Lock()
	entry, known := c.entries[claim.key.String()]
	if !known || entry.generation != claim.generation {
		c.mu.Unlock()
		return
	}
	entry.receipt = receipt
	entry.completed = true
	c.mu.Unlock()
	select {
	case <-entry.done:
	default:
		close(entry.done)
	}
}

// Abandon drops a claim without remembering its outcome, while still handing
// that outcome to any caller already waiting on it.
//
// It is used when the event turned out to have an unknown sender or an
// unresolvable target. Those are not deliveries: remembering them would let a
// request that arrived before the sender was known poison a later, legitimate
// retry that would have succeeded.
func (c *ReceiptCache) Abandon(claim Claim, receipt Receipt) {
	id := claim.key.String()
	c.mu.Lock()
	entry, known := c.entries[id]
	if known && entry.generation != claim.generation {
		// A newer claim owns the key; this one has nothing left to abandon.
		c.mu.Unlock()
		return
	}
	if known {
		entry.receipt = receipt
		entry.completed = true
		delete(c.entries, id)
	}
	c.mu.Unlock()
	if !known {
		return
	}
	select {
	case <-entry.done:
	default:
		close(entry.done)
	}
}

// expireKey reclaims one known key immediately. This keeps retries exact even
// between periodic full sweeps.
func (c *ReceiptCache) expireKey(id string, now time.Time) {
	entry, known := c.entries[id]
	if !known || now.Before(entry.expiresAt) {
		return
	}
	c.expireEntry(id, entry)
}

// expireEntry releases an expired leader with an explicit unknown outcome.
// The caller holds c.mu.
func (c *ReceiptCache) expireEntry(id string, entry *receiptEntry) {
	if !entry.completed {
		entry.completed = true
		entry.receipt = Receipt{Reason: ReasonInProgress}
		select {
		case <-entry.done:
		default:
			close(entry.done)
		}
	}
	delete(c.entries, id)
}

// sweep drops every expired entry. It is periodic during normal traffic and
// forced at capacity, avoiding an O(cache-size) scan for every signal while
// keeping the hard ceiling exact.
func (c *ReceiptCache) sweep(now time.Time) {
	c.sweptAt = now
	for id, entry := range c.entries {
		if now.After(entry.expiresAt) {
			c.expireEntry(id, entry)
		}
	}
}

// evictOne makes room for new claims by dropping a batch of the oldest
// *completed* entries.
//
// Only completed entries are eligible: an in-flight one is the sole record that
// a delivery is happening, and removing it would let a concurrent retry become
// a second leader and deliver the same signal twice. It reports whether a slot
// was freed.
func (c *ReceiptCache) evictOne(now time.Time) bool {
	type candidate struct {
		id        string
		claimedAt time.Time
	}
	completed := make([]candidate, 0, 16)
	for id, entry := range c.entries {
		if entry.completed {
			completed = append(completed, candidate{id: id, claimedAt: entry.claimedAt})
		}
	}
	if len(completed) == 0 {
		return false
	}
	sort.Slice(completed, func(left, right int) bool {
		if completed[left].claimedAt.Equal(completed[right].claimedAt) {
			return completed[left].id < completed[right].id
		}
		return completed[left].claimedAt.Before(completed[right].claimedAt)
	})
	batch := c.capacity / 8
	if batch < 1 {
		batch = 1
	}
	if batch > len(completed) {
		batch = len(completed)
	}
	for _, item := range completed[:batch] {
		delete(c.entries, item.id)
	}
	return true
}
