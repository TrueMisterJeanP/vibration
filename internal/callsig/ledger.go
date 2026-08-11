package callsig

import (
	"sort"
	"sync"
	"time"
)

// Additional rejection reasons produced by the ledger.
const (
	ReasonDuplicate = "duplicate"
	ReasonStale     = "stale_sequence"
	ReasonRateLimit = "rate_limited"
	// ReasonCallEnded marks a signal that belongs to a call which has already
	// been hung up or rejected. It is distinct from a duplicate: the event is
	// new, the call it refers to is not.
	ReasonCallEnded = "call_ended"
)

// BroadcastTarget is the sequence scope of a signal addressed to the whole
// conversation rather than to one participant.
const BroadcastTarget = "*"

const (
	// LedgerCapacity is a hard per-map ceiling. Each of the three maps is
	// bounded independently, because they grow from different inputs: `seen`
	// from distinct event ids, `sequences` from distinct call ids and targets,
	// `terminated` from distinct ended calls. Bounding only one of them — as an
	// earlier version did — left the others free to grow, and the receive path
	// happens not to populate `seen` at all.
	LedgerCapacity = 8192
	ledgerSweep    = 15 * time.Second
	// tombstoneTTL keeps an ended call refusable for long enough that a signal
	// still in flight when the call ended cannot be applied afterwards, and
	// short enough that the memory is reclaimed quickly.
	tombstoneTTL = 2 * time.Minute
)

// sequenceKey scopes a negotiation sequence.
//
// A sequence is per conversation, per sender, per call and per addressee.
// Scoping it by call alone meant a signal sent to one participant made a
// lower-numbered signal to a *different* participant look stale, so in a group
// the second peer's offer was silently dropped. The conversation is part of the
// key because call identifiers are chosen by clients: the same one can appear
// in two unrelated conversations and must not share ordering state.
type sequenceKey struct {
	conversationID int64
	sender         string
	callID         string
	target         string
}

// terminalKey scopes a tombstone. Ending a call in one conversation must never
// block a call that happens to carry the same identifier in another.
type terminalKey struct {
	conversationID int64
	sender         string
	callID         string
}

// seenKey scopes deduplication. The event id alone is not enough: it is chosen
// by the client, so two senders — or one sender in two conversations — can pick
// the same one, and a collision would silently drop a legitimate signal.
type seenKey struct {
	conversationID int64
	sender         string
	eventID        string
}

type sequenceEntry struct {
	value     int64
	touchedAt time.Time
}

// LedgerStats reports the three tracked map sizes, so a test or an operator can
// verify each bound separately rather than inferring one from another.
type LedgerStats struct {
	Seen       int
	Sequences  int
	Terminated int
	// Evicted counts entries dropped to honour a ceiling rather than because
	// they expired. A non-zero value means a peer is churning identifiers.
	Evicted int64
}

// Ledger deduplicates call events, rejects stale ones and remembers which calls
// have ended.
//
// It is deliberately usable by both ends of a hop. The emitting server uses it
// so a client that retries cannot make the same offer travel twice, and the
// receiving server uses it so a hostile or retrying peer cannot replay a signal
// it already delivered. Neither side has to trust the other's bookkeeping.
type Ledger struct {
	mu         sync.Mutex
	now        func() time.Time
	seen       map[seenKey]time.Time
	sequences  map[sequenceKey]sequenceEntry
	terminated map[terminalKey]time.Time
	sweptAt    time.Time
	capacity   int
	evicted    int64
}

// NewLedger builds a ledger using the wall clock.
func NewLedger() *Ledger { return NewLedgerWithClock(time.Now) }

// NewLedgerWithClock builds a ledger with an injected clock, for tests.
func NewLedgerWithClock(now func() time.Time) *Ledger {
	return &Ledger{
		now: now, seen: map[seenKey]time.Time{},
		sequences: map[sequenceKey]sequenceEntry{}, terminated: map[terminalKey]time.Time{},
		capacity: LedgerCapacity,
	}
}

// SetCapacity overrides the per-map ceiling, for tests.
func (l *Ledger) SetCapacity(capacity int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.capacity = capacity
}

// Stats reports the current size of each map.
func (l *Ledger) Stats() LedgerStats {
	l.mu.Lock()
	defer l.mu.Unlock()
	return LedgerStats{
		Seen: len(l.seen), Sequences: len(l.sequences),
		Terminated: len(l.terminated), Evicted: l.evicted,
	}
}

// SequenceScope is the addressee half of a sequence key: the canonical target
// identity, or BroadcastTarget when the signal goes to the whole conversation.
func (e Event) SequenceScope() string {
	if e.Target == nil {
		return BroadcastTarget
	}
	return e.Target.Canonical()
}

// Accept records an event and reports whether it may be delivered. A rejected
// event comes with a stable reason so the caller can decide between silently
// dropping it (a duplicate is not an error) and reporting it.
func (l *Ledger) Accept(event Event) (bool, string) {
	return l.admit(event, true)
}

// Admit performs every check Accept does except deduplication by event id.
//
// The receiving side uses it because deduplication there is owned by the
// receipt cache, which has to return the *outcome* of the first attempt rather
// than merely notice that an id was seen before. Every bound still applies:
// this path populates `sequences` and `terminated`, so those maps must be
// capped here exactly as they are on the emitting path.
func (l *Ledger) Admit(event Event) (bool, string) {
	return l.admit(event, false)
}

func (l *Ledger) admit(event Event, deduplicate bool) (bool, string) {
	now := l.now()
	if event.Expired(now) {
		return false, ReasonExpired
	}
	expiresAt, err := ParseTime(event.ExpiresAt)
	if err != nil {
		return false, ReasonExpired
	}
	sender := event.Sender.Canonical()
	conversation := event.ConversationID
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweep(now)
	if deduplicate {
		key := seenKey{conversationID: conversation, sender: sender, eventID: event.EventID}
		if _, duplicate := l.seen[key]; duplicate {
			return false, ReasonDuplicate
		}
	}
	// A call that has ended stays ended. Without this, an offer still in flight
	// when the user hung up would be applied to a session that no longer exists
	// — a brand new event id makes it invisible to deduplication.
	if !event.Terminal() {
		ended := terminalKey{conversationID: conversation, sender: sender, callID: event.CallID}
		if endsAt, found := l.terminated[ended]; found && now.Before(endsAt) {
			return false, ReasonCallEnded
		}
	}
	// ICE candidates are exempt from the ordering rule. They are independent
	// facts about the network path and the browser handles them in any order,
	// so rejecting one that arrives after a later sibling would silently drop a
	// usable route. Negotiation-critical signals are ordered: an offer or answer
	// older than one already processed can only undo a completed handshake.
	if event.Type != TypeCandidate {
		key := sequenceKey{
			conversationID: conversation, sender: sender,
			callID: event.CallID, target: event.SequenceScope(),
		}
		entry, known := l.sequences[key]
		if known && event.Sequence > 0 && event.Sequence < entry.value {
			return false, ReasonStale
		}
		if !known || event.Sequence > entry.value {
			l.putSequence(key, sequenceEntry{value: event.Sequence, touchedAt: now})
		}
	}
	// A terminal signal records its own tombstone here rather than relying on
	// every caller to remember: this is the single point every accepted event
	// passes through, so a call cannot be ended on one path and left open on
	// another.
	if event.Terminal() {
		l.putTerminated(terminalKey{conversationID: conversation, sender: sender, callID: event.CallID}, now.Add(tombstoneTTL))
		l.forgetSequences(conversation, sender, event.CallID)
	}
	if deduplicate {
		l.putSeen(seenKey{conversationID: conversation, sender: sender, eventID: event.EventID}, expiresAt.Add(MaxClockSkew))
	}
	return true, ReasonDelivered
}

// Finish records that a call ended and drops the sequence state it no longer
// needs. The tombstone outlives the sequences on purpose: the sequences exist
// to order a live negotiation, the tombstone exists to refuse a dead one.
//
// Only this conversation's and this sender's state is touched. Call identifiers
// are chosen by clients, so the same one routinely appears elsewhere; clearing
// by call id alone would reset a stranger's live negotiation.
func (l *Ledger) Finish(conversationID int64, sender Identity, callID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	canonical := sender.Canonical()
	l.putTerminated(terminalKey{conversationID: conversationID, sender: canonical, callID: callID}, l.now().Add(tombstoneTTL))
	l.forgetSequences(conversationID, canonical, callID)
}

// Forget drops the sequence state one sender holds for a call in one
// conversation, without marking it ended. It is used when a call is torn down
// locally and nothing more will be routed for it.
func (l *Ledger) Forget(conversationID int64, sender Identity, callID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.forgetSequences(conversationID, sender.Canonical(), callID)
}

func (l *Ledger) forgetSequences(conversationID int64, sender, callID string) {
	for key := range l.sequences {
		if key.conversationID == conversationID && key.callID == callID && key.sender == sender {
			delete(l.sequences, key)
		}
	}
}

// putSeen, putSequence and putTerminated are the only writers. Each enforces
// its own ceiling before inserting, so no map can exceed its capacity even
// momentarily between sweeps.
func (l *Ledger) putSeen(key seenKey, expiresAt time.Time) {
	if l.capacity <= 0 {
		l.evicted++
		return
	}
	if _, replacing := l.seen[key]; !replacing {
		l.makeRoomInSeen()
	}
	l.seen[key] = expiresAt
}

func (l *Ledger) putSequence(key sequenceKey, entry sequenceEntry) {
	if l.capacity <= 0 {
		l.evicted++
		return
	}
	if _, replacing := l.sequences[key]; !replacing {
		l.makeRoomInSequences()
	}
	l.sequences[key] = entry
}

func (l *Ledger) putTerminated(key terminalKey, endsAt time.Time) {
	if l.capacity <= 0 {
		l.evicted++
		return
	}
	if _, replacing := l.terminated[key]; !replacing {
		l.makeRoomInTerminated()
	}
	l.terminated[key] = endsAt
}

// The three eviction helpers share one policy: drop a batch of entries that
// will expire (or were touched) first.
//
// At saturation the ledger degrades rather than grows. For `seen` that means a
// very old event id could be accepted twice; for `sequences`, an ordering
// decision falls back to "no history"; for `terminated`, an ended call may stop
// being refused early. All three are recoverable and bounded in blast radius,
// whereas an unbounded map is not.
//
// Evicting one entry per insertion would require a full scan of an 8192-entry
// map for every signal after saturation. Removing a small batch amortizes that
// scan and prevents a bounded-memory defence from becoming a CPU exhaustion
// path of its own.
func evictionBatch(size, capacity int) int {
	if size == 0 {
		return 0
	}
	batch := capacity / 8
	if batch < 1 {
		batch = 1
	}
	required := size - capacity + 1
	if required > batch {
		batch = required
	}
	if batch > size {
		batch = size
	}
	return batch
}

func (l *Ledger) makeRoomInSeen() {
	if len(l.seen) < l.capacity {
		return
	}
	type candidate struct {
		key seenKey
		at  time.Time
	}
	candidates := make([]candidate, 0, len(l.seen))
	for key, expiresAt := range l.seen {
		candidates = append(candidates, candidate{key: key, at: expiresAt})
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].at.Before(candidates[j].at) })
	for _, item := range candidates[:evictionBatch(len(candidates), l.capacity)] {
		delete(l.seen, item.key)
		l.evicted++
	}
}

func (l *Ledger) makeRoomInSequences() {
	if len(l.sequences) < l.capacity {
		return
	}
	type candidate struct {
		key sequenceKey
		at  time.Time
	}
	candidates := make([]candidate, 0, len(l.sequences))
	for key, entry := range l.sequences {
		candidates = append(candidates, candidate{key: key, at: entry.touchedAt})
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].at.Before(candidates[j].at) })
	for _, item := range candidates[:evictionBatch(len(candidates), l.capacity)] {
		delete(l.sequences, item.key)
		l.evicted++
	}
}

func (l *Ledger) makeRoomInTerminated() {
	if len(l.terminated) < l.capacity {
		return
	}
	type candidate struct {
		key terminalKey
		at  time.Time
	}
	candidates := make([]candidate, 0, len(l.terminated))
	for key, endsAt := range l.terminated {
		candidates = append(candidates, candidate{key: key, at: endsAt})
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].at.Before(candidates[j].at) })
	for _, item := range candidates[:evictionBatch(len(candidates), l.capacity)] {
		delete(l.terminated, item.key)
		l.evicted++
	}
}

// sweep reclaims expired entries. It runs on a timer rather than on every call
// because it is a full scan of three maps; the hard ceilings are what guarantee
// boundedness between sweeps.
func (l *Ledger) sweep(now time.Time) {
	if now.Sub(l.sweptAt) < ledgerSweep {
		return
	}
	l.sweptAt = now
	for key, expiresAt := range l.seen {
		if now.After(expiresAt) {
			delete(l.seen, key)
		}
	}
	for key, endsAt := range l.terminated {
		if now.After(endsAt) {
			delete(l.terminated, key)
		}
	}
	// Sequence entries carry no expiry of their own: they are alive for as long
	// as the negotiation is. They are reclaimed once no signal has touched them
	// for longer than a call could plausibly stay silent.
	for key, entry := range l.sequences {
		if now.Sub(entry.touchedAt) > tombstoneTTL {
			delete(l.sequences, key)
		}
	}
}

// RateLimiterCapacity is a hard ceiling on tracked buckets. Without it, a
// compromised instance could mint thousands of distinct identities inside one
// eviction window and grow the map for as long as it kept them active.
const RateLimiterCapacity = 4096

// rateLimiterIdle is how long a bucket may sit untouched before it is evicted
// to make room. It is comfortably longer than the slowest bucket takes to
// refill, so evicting an idle bucket never hands anyone a fresh budget early.
const rateLimiterIdle = time.Minute

// RateLimiter caps how often one participant may emit the signal types that are
// cheap to produce and expensive to route: call invitations, which ring every
// member of a conversation, and ICE candidates, which a peer emits in bursts.
type RateLimiter struct {
	mu       sync.Mutex
	now      func() time.Time
	buckets  map[string]*bucket
	sweptAt  time.Time
	capacity int
	// refused counts claims rejected because every bucket was still active. It
	// is exported through Stats for operators: a non-zero value means an
	// instance is churning identities.
	refused int64
}

type bucket struct {
	tokens   float64
	updated  time.Time
	capacity float64
	refill   float64
}

type limitRule struct {
	capacity float64
	refill   float64
}

// Per-second refill rates chosen from what a legitimate client produces: a
// handful of invitations a minute, and one ICE burst of a few dozen candidates
// per negotiation or restart.
var limitRules = map[string]limitRule{
	TypeInvite:    {capacity: 6, refill: 0.2},
	TypeCandidate: {capacity: 80, refill: 20},
	TypeResync:    {capacity: 8, refill: 0.5},
}

// NewRateLimiter builds a limiter using the wall clock.
func NewRateLimiter() *RateLimiter { return NewRateLimiterWithClock(time.Now) }

// NewRateLimiterWithClock builds a limiter with an injected clock, for tests.
func NewRateLimiterWithClock(now func() time.Time) *RateLimiter {
	return &RateLimiter{now: now, buckets: map[string]*bucket{}, capacity: RateLimiterCapacity}
}

// SetCapacity overrides the hard ceiling, for tests.
func (r *RateLimiter) SetCapacity(capacity int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.capacity = capacity
}

// Stats reports the tracked bucket count and how many claims were refused for
// lack of a slot.
func (r *RateLimiter) Stats() (buckets int, refused int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.buckets), r.refused
}

// Allow reports whether this sender may emit this signal type now.
func (r *RateLimiter) Allow(sender Identity, eventType string) bool {
	return r.AllowScoped("", sender, eventType)
}

// AllowScoped is Allow with an extra bucket dimension, used at the federated
// boundary to key the limit by signing instance as well as by claimed identity.
// Without the instance in the key, one misbehaving peer could exhaust the
// budget of an identity hosted somewhere else.
func (r *RateLimiter) AllowScoped(scope string, sender Identity, eventType string) bool {
	rule, limited := limitRules[eventType]
	if !limited {
		return true
	}
	now := r.now()
	key := scope + "\x00" + sender.Canonical() + "\x00" + eventType
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Sub(r.sweptAt) > rateLimiterIdle {
		r.sweptAt = now
		for name, item := range r.buckets {
			if now.Sub(item.updated) > rateLimiterIdle {
				delete(r.buckets, name)
			}
		}
	}
	item, known := r.buckets[key]
	if !known {
		if len(r.buckets) >= r.capacity && !r.evictIdle(now) {
			// Every bucket is active. Refusing is the bounded outcome: the
			// alternative is either unbounded memory or evicting a live bucket,
			// which would hand its owner a fresh budget on demand.
			r.refused++
			return false
		}
		item = &bucket{tokens: rule.capacity, updated: now, capacity: rule.capacity, refill: rule.refill}
		r.buckets[key] = item
	}
	item.tokens += now.Sub(item.updated).Seconds() * item.refill
	item.updated = now
	if item.tokens > item.capacity {
		item.tokens = item.capacity
	}
	if item.tokens < 1 {
		return false
	}
	item.tokens--
	return true
}

// evictIdle frees one slot by dropping the least recently used bucket that has
// been idle long enough to have refilled anyway. It reports whether a slot was
// freed.
func (r *RateLimiter) evictIdle(now time.Time) bool {
	oldestKey := ""
	var oldest time.Time
	for key, item := range r.buckets {
		if now.Sub(item.updated) <= rateLimiterIdle {
			continue
		}
		if oldestKey == "" || item.updated.Before(oldest) {
			oldestKey, oldest = key, item.updated
		}
	}
	if oldestKey == "" {
		return false
	}
	delete(r.buckets, oldestKey)
	return true
}
