package callsig

import (
	"strconv"
	"testing"
	"time"
)

func TestIdentityNormalization(t *testing.T) {
	tests := []struct {
		name      string
		instance  string
		username  string
		canonical string
	}{
		{"trailing slash", "https://Alpha.Example/", "Alice", "https://alpha.example|alice"},
		{"default https port", "https://alpha.example:443", "alice", "https://alpha.example|alice"},
		{"explicit port kept", "https://alpha.example:8443/", "alice", "https://alpha.example:8443|alice"},
		{"path preserved", "https://alpha.example/chat/", "alice", "https://alpha.example/chat|alice"},
		{"no base url", "", "alice", "local|alice"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			identity := NewIdentity(test.instance, test.username)
			if identity.Canonical() != test.canonical {
				t.Fatalf("canonical=%q want %q", identity.Canonical(), test.canonical)
			}
			if !identity.Valid() {
				t.Fatalf("identity %q reported invalid", identity.Canonical())
			}
		})
	}
}

func TestParseIdentityRejectsMalformedValues(t *testing.T) {
	for _, value := range []string{"", "alice", "https://alpha.example|", "|alice", "ftp://alpha.example|alice", "https://alpha.example|Bad Name"} {
		if _, ok := ParseIdentity(value); ok {
			t.Fatalf("identity %q unexpectedly accepted", value)
		}
	}
	identity, ok := ParseIdentity("https://alpha.example|alice")
	if !ok || identity.Username != "alice" {
		t.Fatalf("identity=%+v ok=%v", identity, ok)
	}
}

// TestPoliteRoleIsIndependentOfLocalIdentifiers is the core regression test for
// the negotiation collision. Whatever numeric ids each database happens to
// allocate, exactly one side of a pair must be polite.
func TestPoliteRoleIsIndependentOfLocalIdentifiers(t *testing.T) {
	alice := NewIdentity("https://alpha.example", "alice")
	bob := NewIdentity("https://beta.example", "bob")
	if Polite(alice, bob) == Polite(bob, alice) {
		t.Fatal("both peers reached the same politeness verdict")
	}
	// Same participants, opposite spellings: the verdict must not move.
	if Polite(NewIdentity("https://ALPHA.example/", "Alice"), bob) != Polite(alice, bob) {
		t.Fatal("politeness changed with identity spelling")
	}
}

func TestValidateRejectsMalformedEvents(t *testing.T) {
	now := time.Now()
	valid := func() Event {
		event := Event{
			EventID: "event-1", CallID: "call-1", Sequence: 1, Type: TypeOffer, Media: "audio",
			Sender: NewIdentity("https://alpha.example", "alice"),
			SDP:    &SessionDescription{Type: "offer", SDP: "v=0"},
		}
		event.Normalize(now)
		return event
	}
	if err := valid().Validate(now); err != nil {
		t.Fatalf("valid event rejected: %v", err)
	}
	tests := []struct {
		name   string
		mutate func(*Event)
	}{
		{"unknown type", func(e *Event) { e.Type = "call_scream" }},
		{"unknown version", func(e *Event) { e.Version = "federated-calls" }},
		{"missing sdp", func(e *Event) { e.SDP = nil }},
		{"oversized sdp", func(e *Event) { e.SDP.SDP = string(make([]byte, maxSDPLength+1)) }},
		{"invalid sdp type", func(e *Event) { e.SDP.Type = "proposal" }},
		{"invalid media", func(e *Event) { e.Media = "screen" }},
		{"missing call id", func(e *Event) { e.CallID = "" }},
		{"missing event id", func(e *Event) { e.EventID = "" }},
		{"invalid sender", func(e *Event) { e.Sender = Identity{Instance: "https://alpha.example", Username: "x"} }},
		{"self addressed", func(e *Event) { target := e.Sender; e.Target = &target }},
		{"negative sequence", func(e *Event) { e.Sequence = -1 }},
		{"expired", func(e *Event) { e.ExpiresAt = FormatTime(now.Add(-2 * time.Minute)) }},
		{"expiry too far", func(e *Event) { e.ExpiresAt = FormatTime(now.Add(10 * time.Minute)) }},
		{"created in the future", func(e *Event) {
			e.CreatedAt = FormatTime(now.Add(5 * time.Minute))
			e.ExpiresAt = FormatTime(now.Add(6 * time.Minute))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			event := valid()
			test.mutate(&event)
			if err := event.Validate(now); err == nil {
				t.Fatalf("event %q unexpectedly accepted", test.name)
			}
		})
	}
}

func TestValidateRejectsOversizedCandidate(t *testing.T) {
	now := time.Now()
	event := Event{
		EventID: "event-2", CallID: "call-1", Type: TypeCandidate,
		Sender:    NewIdentity("https://alpha.example", "alice"),
		Candidate: &IceCandidate{Candidate: string(make([]byte, maxCandidateLength+1))},
	}
	event.Normalize(now)
	if err := event.Validate(now); err == nil {
		t.Fatal("oversized ice candidate unexpectedly accepted")
	}
}

func TestLedgerDeduplicatesAndExpires(t *testing.T) {
	clock := time.Now()
	ledger := NewLedgerWithClock(func() time.Time { return clock })
	sender := NewIdentity("https://alpha.example", "alice")
	event := Event{EventID: "event-1", CallID: "call-1", Sequence: 2, Type: TypeOffer, Sender: sender}
	event.Normalize(clock)

	if ok, reason := ledger.Accept(event); !ok {
		t.Fatalf("first delivery rejected: %s", reason)
	}
	if ok, reason := ledger.Accept(event); ok || reason != ReasonDuplicate {
		t.Fatalf("duplicate ok=%v reason=%s", ok, reason)
	}

	stale := Event{EventID: "event-0", CallID: "call-1", Sequence: 1, Type: TypeOffer, Sender: sender}
	stale.Normalize(clock)
	if ok, reason := ledger.Accept(stale); ok || reason != ReasonStale {
		t.Fatalf("stale offer ok=%v reason=%s", ok, reason)
	}

	// A late ICE candidate is not stale: candidates describe independent paths
	// and the browser accepts them in any order.
	candidate := Event{EventID: "event-3", CallID: "call-1", Sequence: 1, Type: TypeCandidate, Sender: sender}
	candidate.Normalize(clock)
	if ok, reason := ledger.Accept(candidate); !ok {
		t.Fatalf("late ice candidate rejected: %s", reason)
	}

	expired := Event{EventID: "event-4", CallID: "call-1", Sequence: 9, Type: TypeOffer, Sender: sender}
	expired.Normalize(clock)
	clock = clock.Add(DefaultTTL + MaxClockSkew + time.Second)
	if ok, reason := ledger.Accept(expired); ok || reason != ReasonExpired {
		t.Fatalf("expired event ok=%v reason=%s", ok, reason)
	}
}

func TestLedgerForgetsEndedCall(t *testing.T) {
	clock := time.Now()
	ledger := NewLedgerWithClock(func() time.Time { return clock })
	sender := NewIdentity("https://alpha.example", "alice")
	first := Event{EventID: "event-1", CallID: "call-1", Sequence: 5, Type: TypeOffer, Sender: sender}
	first.Normalize(clock)
	ledger.Accept(first)
	ledger.Forget(0, sender, "call-1")

	// A new call reusing low sequence numbers must not be judged against the
	// sequence of a call that no longer exists.
	next := Event{EventID: "event-2", CallID: "call-1", Sequence: 1, Type: TypeOffer, Sender: sender}
	next.Normalize(clock)
	if ok, reason := ledger.Accept(next); !ok {
		t.Fatalf("post-hangup sequence reset rejected: %s", reason)
	}
}

func TestRateLimiterCapsInvitations(t *testing.T) {
	clock := time.Now()
	limiter := NewRateLimiterWithClock(func() time.Time { return clock })
	sender := NewIdentity("https://alpha.example", "alice")
	allowed := 0
	for attempt := 0; attempt < 20; attempt++ {
		if limiter.Allow(sender, TypeInvite) {
			allowed++
		}
	}
	if allowed == 0 || allowed >= 20 {
		t.Fatalf("invitation limiter allowed %d of 20", allowed)
	}
	// Answers are not rate limited: they are one per negotiation and delaying
	// one would break a call rather than protect anything.
	for attempt := 0; attempt < 50; attempt++ {
		if !limiter.Allow(sender, TypeAnswer) {
			t.Fatal("call answer unexpectedly rate limited")
		}
	}
	clock = clock.Add(time.Minute)
	if !limiter.Allow(sender, TypeInvite) {
		t.Fatal("invitation bucket did not refill")
	}
}

// TestRateLimiterIsBounded covers the flood a compromised instance can produce:
// thousands of distinct identities inside one eviction window. The map must
// stop growing rather than track every one of them.
func TestRateLimiterIsBounded(t *testing.T) {
	const capacity = 128
	clock := time.Now()
	limiter := NewRateLimiterWithClock(func() time.Time { return clock })
	limiter.SetCapacity(capacity)

	allowed := 0
	for index := 0; index < capacity*4; index++ {
		identity := NewIdentity("https://alpha.example", "user_"+strconv.Itoa(index))
		if limiter.AllowScoped("1", identity, TypeInvite) {
			allowed++
		}
	}
	buckets, refused := limiter.Stats()
	if buckets > capacity {
		t.Fatalf("buckets=%d exceeded the hard ceiling %d", buckets, capacity)
	}
	if refused == 0 {
		t.Fatal("a flood of distinct identities must be refused, not tracked")
	}
	if allowed != capacity {
		t.Fatalf("allowed=%d, only the first %d identities should have obtained a bucket", allowed, capacity)
	}

	// Once the existing buckets go idle they may be reclaimed, so a legitimate
	// new identity is not locked out forever.
	clock = clock.Add(2 * time.Minute)
	if !limiter.AllowScoped("1", NewIdentity("https://alpha.example", "late_arrival"), TypeInvite) {
		t.Fatal("an idle bucket must be reclaimed for a new identity")
	}
	if buckets, _ := limiter.Stats(); buckets > capacity {
		t.Fatalf("buckets=%d after reclaiming", buckets)
	}
}

// TestTombstoneOnlyClearsItsOwnSenderSequences guards a subtle collision: call
// identifiers are chosen by clients, so two unrelated participants can pick the
// same one. Ending one call must not reset the other's live negotiation.
func TestTombstoneOnlyClearsItsOwnSenderSequences(t *testing.T) {
	clock := time.Now()
	ledger := NewLedgerWithClock(func() time.Time { return clock })
	alice := NewIdentity("https://alpha.example", "alice")
	carol := NewIdentity("https://gamma.example", "carol")

	offer := func(sender Identity, id string, sequence int64) Event {
		event := Event{
			EventID: id, CallID: "shared-call-id", Sequence: sequence, Type: TypeOffer, Media: "audio",
			Sender: sender, SDP: &SessionDescription{Type: "offer", SDP: "v=0"},
		}
		event.Normalize(clock)
		return event
	}
	if ok, reason := ledger.Accept(offer(alice, "a1", 5)); !ok {
		t.Fatalf("alice's offer rejected: %s", reason)
	}
	if ok, reason := ledger.Accept(offer(carol, "c1", 5)); !ok {
		t.Fatalf("carol's offer rejected: %s", reason)
	}

	hangup := Event{EventID: "a2", CallID: "shared-call-id", Sequence: 6, Type: TypeHangup, Media: "audio", Sender: alice}
	hangup.Normalize(clock)
	ledger.Accept(hangup)

	// Alice's call is over: a fresh offer from her is refused.
	if ok, reason := ledger.Accept(offer(alice, "a3", 7)); ok || reason != ReasonCallEnded {
		t.Fatalf("alice's post-hangup offer ok=%v reason=%s", ok, reason)
	}
	// Carol's identically named call is untouched, and her sequence state was
	// not cleared: an older offer of hers is still judged stale.
	if ok, reason := ledger.Accept(offer(carol, "c2", 2)); ok || reason != ReasonStale {
		t.Fatalf("carol's sequence state was cleared by another sender's hangup: ok=%v reason=%s", ok, reason)
	}
	if ok, reason := ledger.Accept(offer(carol, "c3", 8)); !ok {
		t.Fatalf("carol's live call was ended by another sender's hangup: %s", reason)
	}
}

// ledgerOffer builds an offer for one conversation, sender and call.
func ledgerOffer(conversationID int64, sender Identity, callID, eventID string, sequence int64, now time.Time) Event {
	event := Event{
		ConversationID: conversationID, EventID: eventID, CallID: callID, Sequence: sequence,
		Type: TypeOffer, Media: "audio", Sender: sender,
		SDP: &SessionDescription{Type: "offer", SDP: "v=0"},
	}
	event.Normalize(now)
	return event
}

// TestLedgerAdmitIsBounded is the regression for the map that was never capped.
//
// Admit is the receive path: it does not populate `seen`, so the old sweep
// trigger — which only looked at `seen` and `terminated` — never fired, and a
// peer sending offers with distinct call ids grew `sequences` without limit.
func TestLedgerAdmitIsBounded(t *testing.T) {
	clock := time.Now()
	ledger := NewLedgerWithClock(func() time.Time { return clock })
	sender := NewIdentity("https://alpha.example", "alice")

	const flood = LedgerCapacity * 3
	for index := 0; index < flood; index++ {
		event := ledgerOffer(42, sender, "call-"+strconv.Itoa(index), "event-"+strconv.Itoa(index), 1, clock)
		if ok, reason := ledger.Admit(event); !ok {
			t.Fatalf("offer %d rejected: %s", index, reason)
		}
	}
	stats := ledger.Stats()
	if stats.Sequences > LedgerCapacity {
		t.Fatalf("sequences=%d exceeded the ceiling %d", stats.Sequences, LedgerCapacity)
	}
	if stats.Evicted == 0 {
		t.Fatal("a flood of distinct call ids must evict, not accumulate")
	}
	// Admit deliberately does not deduplicate, so `seen` must stay empty rather
	// than growing on a path that never reads it.
	if stats.Seen != 0 {
		t.Fatalf("seen=%d on the Admit path", stats.Seen)
	}

	// Terminal events grow a different map; it is capped independently.
	for index := 0; index < flood; index++ {
		event := Event{
			ConversationID: 42, EventID: "end-" + strconv.Itoa(index), CallID: "hang-" + strconv.Itoa(index),
			Sequence: 1, Type: TypeHangup, Media: "audio", Sender: sender,
		}
		event.Normalize(clock)
		if ok, reason := ledger.Admit(event); !ok {
			t.Fatalf("hangup %d rejected: %s", index, reason)
		}
	}
	if stats := ledger.Stats(); stats.Terminated > LedgerCapacity {
		t.Fatalf("terminated=%d exceeded the ceiling %d", stats.Terminated, LedgerCapacity)
	}

	// The deduplication map is capped on the Accept path too.
	for index := 0; index < flood; index++ {
		event := ledgerOffer(43, sender, "seen-call", "seen-event-"+strconv.Itoa(index), 0, clock)
		ledger.Accept(event)
	}
	if stats := ledger.Stats(); stats.Seen > LedgerCapacity {
		t.Fatalf("seen=%d exceeded the ceiling %d", stats.Seen, LedgerCapacity)
	}
}

// TestLedgerScopesEverythingByConversation proves the four isolation rules that
// matter: call ids and event ids are chosen by clients, so the same value
// appears in unrelated conversations and from unrelated senders.
func TestLedgerScopesEverythingByConversation(t *testing.T) {
	clock := time.Now()
	ledger := NewLedgerWithClock(func() time.Time { return clock })
	alice := NewIdentity("https://alpha.example", "alice")
	carol := NewIdentity("https://gamma.example", "carol")

	t.Run("the same event id is accepted in two conversations", func(t *testing.T) {
		if ok, reason := ledger.Accept(ledgerOffer(1, alice, "call-a", "shared-event", 1, clock)); !ok {
			t.Fatalf("first conversation rejected: %s", reason)
		}
		if ok, reason := ledger.Accept(ledgerOffer(2, alice, "call-a", "shared-event", 1, clock)); !ok {
			t.Fatalf("the same event id collided across conversations: %s", reason)
		}
		// Within one conversation it is still a duplicate.
		if ok, reason := ledger.Accept(ledgerOffer(1, alice, "call-a", "shared-event", 1, clock)); ok || reason != ReasonDuplicate {
			t.Fatalf("intra-conversation duplicate ok=%v reason=%s", ok, reason)
		}
	})

	t.Run("one call id in two conversations shares no sequence", func(t *testing.T) {
		if ok, reason := ledger.Accept(ledgerOffer(3, alice, "same-call", "e-high", 50, clock)); !ok {
			t.Fatalf("high sequence rejected: %s", reason)
		}
		// A low sequence in the other conversation must not look stale.
		if ok, reason := ledger.Accept(ledgerOffer(4, alice, "same-call", "e-low", 1, clock)); !ok {
			t.Fatalf("sequences leaked across conversations: %s", reason)
		}
		// Within the first conversation, the ordering rule still applies.
		if ok, reason := ledger.Accept(ledgerOffer(3, alice, "same-call", "e-stale", 2, clock)); ok || reason != ReasonStale {
			t.Fatalf("intra-conversation ordering lost: ok=%v reason=%s", ok, reason)
		}
	})

	t.Run("ending a call in one conversation does not block the other", func(t *testing.T) {
		hangup := Event{
			ConversationID: 5, EventID: "bye", CallID: "twin-call", Sequence: 9,
			Type: TypeHangup, Media: "audio", Sender: alice,
		}
		hangup.Normalize(clock)
		if ok, reason := ledger.Accept(hangup); !ok {
			t.Fatalf("hangup rejected: %s", reason)
		}
		if ok, reason := ledger.Accept(ledgerOffer(5, alice, "twin-call", "late", 10, clock)); ok || reason != ReasonCallEnded {
			t.Fatalf("the ended call was not refused: ok=%v reason=%s", ok, reason)
		}
		// The identically named call in another conversation is untouched.
		if ok, reason := ledger.Accept(ledgerOffer(6, alice, "twin-call", "alive", 1, clock)); !ok {
			t.Fatalf("a tombstone leaked into another conversation: %s", reason)
		}
	})

	t.Run("two senders colliding on one call id stay isolated", func(t *testing.T) {
		if ok, _ := ledger.Accept(ledgerOffer(7, alice, "collide", "a-1", 20, clock)); !ok {
			t.Fatal("alice's offer rejected")
		}
		if ok, reason := ledger.Accept(ledgerOffer(7, carol, "collide", "c-1", 1, clock)); !ok {
			t.Fatalf("carol was judged against alice's sequence: %s", reason)
		}
		hangup := Event{
			ConversationID: 7, EventID: "a-bye", CallID: "collide", Sequence: 21,
			Type: TypeHangup, Media: "audio", Sender: alice,
		}
		hangup.Normalize(clock)
		ledger.Accept(hangup)
		if ok, reason := ledger.Accept(ledgerOffer(7, carol, "collide", "c-2", 2, clock)); !ok {
			t.Fatalf("alice's hangup ended carol's call: %s", reason)
		}
	})
}

// TestLedgerFinishAndForgetAreScoped covers the explicit teardown helpers.
func TestLedgerFinishAndForgetAreScoped(t *testing.T) {
	clock := time.Now()
	ledger := NewLedgerWithClock(func() time.Time { return clock })
	alice := NewIdentity("https://alpha.example", "alice")

	ledger.Accept(ledgerOffer(1, alice, "call-x", "e1", 5, clock))
	ledger.Accept(ledgerOffer(2, alice, "call-x", "e2", 5, clock))

	ledger.Finish(1, alice, "call-x")
	if ok, reason := ledger.Accept(ledgerOffer(1, alice, "call-x", "e3", 6, clock)); ok || reason != ReasonCallEnded {
		t.Fatalf("Finish did not tombstone its own conversation: ok=%v reason=%s", ok, reason)
	}
	if ok, reason := ledger.Accept(ledgerOffer(2, alice, "call-x", "e4", 6, clock)); !ok {
		t.Fatalf("Finish leaked into another conversation: %s", reason)
	}

	// Forget clears ordering without ending the call.
	ledger.Forget(2, alice, "call-x")
	if ok, reason := ledger.Accept(ledgerOffer(2, alice, "call-x", "e5", 1, clock)); !ok {
		t.Fatalf("Forget did not clear the sequence: %s", reason)
	}
}
