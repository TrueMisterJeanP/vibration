package callsig

import (
	"strconv"
	"sync"
	"testing"
	"time"
)

// testReceiptKey builds a key for one instance, conversation and sender, so a
// test that only cares about the event id stays readable.
func testReceiptKey(eventID string) ReceiptKey {
	return ReceiptKey{
		InstanceID: 1, ConversationID: 10,
		Sender: NewIdentity("https://alpha.example", "alice").Canonical(), EventID: eventID,
	}
}

func TestReceiptCacheReplaysTheFirstOutcome(t *testing.T) {
	cache := NewReceiptCache()
	leader, claim, _ := cache.Begin(testReceiptKey("event-1"), time.Minute)
	if !leader {
		t.Fatal("the first caller must lead")
	}
	// A failed delivery is an outcome too. Replaying it as "already delivered"
	// would tell a retrying peer that a call connected when nobody answered.
	cache.Publish(claim, Receipt{Recipients: 1, Delivered: 0, Reason: ReasonRecipientOffline})

	follower, _, receipt := cache.Begin(testReceiptKey("event-1"), time.Minute)
	if follower {
		t.Fatal("a repeat of a completed event must not lead a second delivery")
	}
	if receipt.Delivered != 0 || receipt.Reason != ReasonRecipientOffline || receipt.Recipients != 1 {
		t.Fatalf("replayed receipt=%+v", receipt)
	}
}

func TestReceiptCacheAbandonDoesNotPoisonRetries(t *testing.T) {
	cache := NewReceiptCache()
	leader, claim, _ := cache.Begin(testReceiptKey("event-2"), time.Minute)
	if !leader {
		t.Fatal("expected to lead")
	}
	// An unknown sender is not a delivery. Recording it would make a later,
	// legitimate retry inherit a verdict that was never about delivery.
	cache.Abandon(claim, Receipt{Reason: ReasonUnknownTarget})

	retry, _, _ := cache.Begin(testReceiptKey("event-2"), time.Minute)
	if !retry {
		t.Fatal("an abandoned claim must be re-attemptable")
	}
}

func TestReceiptCacheConcurrentDuplicatesElectOneLeader(t *testing.T) {
	cache := NewReceiptCache()
	cache.SetFollowerWait(500 * time.Millisecond)
	var leaders, followers int
	var mu sync.Mutex
	var wait sync.WaitGroup
	start := make(chan struct{})
	for copy := 0; copy < 8; copy++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			leader, claim, receipt := cache.Begin(testReceiptKey("event-3"), time.Minute)
			mu.Lock()
			defer mu.Unlock()
			if leader {
				leaders++
				cache.Publish(claim, Receipt{Recipients: 1, Delivered: 1})
				return
			}
			followers++
			// A follower gets either the leader's outcome or an explicit
			// "in progress" — never a fabricated failure.
			if receipt.Delivered != 1 && receipt.Reason != ReasonInProgress {
				t.Errorf("follower receipt=%+v", receipt)
			}
		}()
	}
	close(start)
	wait.Wait()
	if leaders != 1 {
		t.Fatalf("leaders=%d, exactly one delivery must be performed", leaders)
	}
	if followers != 7 {
		t.Fatalf("followers=%d", followers)
	}
}

func TestReceiptCacheExpiresEntries(t *testing.T) {
	clock := time.Now()
	cache := NewReceiptCacheWithClock(func() time.Time { return clock })
	leader, claim, _ := cache.Begin(testReceiptKey("event-4"), time.Second)
	if !leader {
		t.Fatal("expected to lead")
	}
	cache.Publish(claim, Receipt{Recipients: 1, Delivered: 1})

	clock = clock.Add(2 * time.Second)
	// Past its retention the entry is gone, so the same id may be delivered
	// again. That is the intended trade: bounded memory, and an event that old
	// has expired at the protocol level anyway.
	again, _, _ := cache.Begin(testReceiptKey("event-4"), time.Second)
	if !again {
		t.Fatal("an expired receipt must be reclaimed")
	}
}

// TestReceiptKeysAreIsolated proves that an event id chosen by one sender can
// never replay another's outcome. The id is attacker-chosen, so the key has to
// include everything already authenticated by the time it is built.
func TestReceiptKeysAreIsolated(t *testing.T) {
	cache := NewReceiptCache()
	alice := NewIdentity("https://alpha.example", "alice").Canonical()
	carol := NewIdentity("https://gamma.example", "carol").Canonical()
	base := ReceiptKey{InstanceID: 1, ConversationID: 10, Sender: alice, EventID: "shared-id"}

	leader, baseClaim, _ := cache.Begin(base, time.Minute)
	if !leader {
		t.Fatal("expected to lead the first claim")
	}
	cache.Publish(baseClaim, Receipt{Recipients: 1, Delivered: 1})

	for _, variant := range []struct {
		name string
		key  ReceiptKey
	}{
		{"another instance", ReceiptKey{InstanceID: 2, ConversationID: 10, Sender: alice, EventID: "shared-id"}},
		{"another conversation", ReceiptKey{InstanceID: 1, ConversationID: 11, Sender: alice, EventID: "shared-id"}},
		{"another sender", ReceiptKey{InstanceID: 1, ConversationID: 10, Sender: carol, EventID: "shared-id"}},
	} {
		t.Run(variant.name, func(t *testing.T) {
			leader, variantClaim, receipt := cache.Begin(variant.key, time.Minute)
			if !leader {
				t.Fatalf("the same event id collided across scopes: receipt=%+v", receipt)
			}
			cache.Publish(variantClaim, Receipt{Recipients: 1, Delivered: 1})
		})
	}
}

func TestReceiptRetentionCoversTheWholeAcceptanceWindow(t *testing.T) {
	now := time.Now()
	event := Event{EventID: "e", CallID: "c", Type: TypeInvite, Sender: NewIdentity("https://alpha.example", "alice")}
	event.CreatedAt = FormatTime(now)
	event.ExpiresAt = FormatTime(now.Add(MaxTTL))
	event.Normalize(now)

	retention := ReceiptRetention(event, now, 5*time.Second)
	// The record has to outlive the event itself, the skew tolerated at the
	// boundary and the sender's retry budget. A shorter fixed value would let a
	// long-lived event be delivered twice.
	if retention < MaxTTL+MaxClockSkew {
		t.Fatalf("retention=%s does not cover the maximum acceptance window", retention)
	}
	// An already-expired event needs no long retention.
	expired := event
	expired.ExpiresAt = FormatTime(now.Add(-time.Minute))
	if short := ReceiptRetention(expired, now, 0); short > MaxClockSkew {
		t.Fatalf("expired event retention=%s", short)
	}
}

// TestReceiptCacheNeverExceedsCapacity covers the two shapes the ceiling has to
// hold: a cache full of finished entries, and a cache where every entry is
// still running.
func TestReceiptCacheNeverExceedsCapacity(t *testing.T) {
	const capacity = 64
	key := func(index int) ReceiptKey {
		return ReceiptKey{InstanceID: 1, ConversationID: 10, Sender: "s", EventID: "event-" + strconv.Itoa(index)}
	}

	t.Run("completed entries are evicted", func(t *testing.T) {
		cache := NewReceiptCache()
		cache.SetCapacity(capacity)
		for index := 0; index < capacity; index++ {
			leader, claim, _ := cache.Begin(key(index), time.Hour)
			if !leader {
				t.Fatalf("claim %d refused while filling", index)
			}
			cache.Publish(claim, Receipt{Recipients: 1, Delivered: 1})
		}
		if size := cache.Size(); size != capacity {
			t.Fatalf("size=%d want %d", size, capacity)
		}
		leader, _, receipt := cache.Begin(key(capacity), time.Hour)
		if !leader {
			t.Fatalf("a full cache of finished entries must make room: %+v", receipt)
		}
		if size := cache.Size(); size > capacity {
			t.Fatalf("size=%d exceeded the hard ceiling %d", size, capacity)
		}
	})

	t.Run("running entries are never dropped", func(t *testing.T) {
		cache := NewReceiptCache()
		cache.SetCapacity(capacity)
		for index := 0; index < capacity; index++ {
			if leader, _, _ := cache.Begin(key(index), time.Hour); !leader {
				t.Fatalf("claim %d refused while filling", index)
			}
			// Deliberately not published: every entry stays in flight.
		}
		leader, _, receipt := cache.Begin(key(capacity), time.Hour)
		if leader {
			t.Fatal("a slot was stolen from a delivery that is still running")
		}
		if receipt.Reason != ReasonCacheFull {
			t.Fatalf("refusal reason=%q want %q", receipt.Reason, ReasonCacheFull)
		}
		if size := cache.Size(); size > capacity {
			t.Fatalf("size=%d exceeded the hard ceiling %d", size, capacity)
		}
		// The entries that were already claimed still elect exactly one leader.
		if again, _, _ := cache.Begin(key(0), time.Hour); again {
			t.Fatal("an in-flight entry produced a second leader")
		}
	})
}

func TestReceiptCacheReleasesFollowersOfAnExpiredLeader(t *testing.T) {
	clock := time.Now()
	cache := NewReceiptCacheWithClock(func() time.Time { return clock })
	cache.SetFollowerWait(50 * time.Millisecond)
	key := ReceiptKey{InstanceID: 1, ConversationID: 10, Sender: "s", EventID: "stuck"}
	if leader, _, _ := cache.Begin(key, time.Second); !leader {
		t.Fatal("expected to lead")
	}
	// The leader never publishes. Past the retention the slot must be reclaimed
	// rather than pinned forever by a request that died mid-flight.
	clock = clock.Add(2 * time.Second)
	again, _, _ := cache.Begin(key, time.Second)
	if !again {
		t.Fatal("an abandoned in-flight entry must be reclaimed once it expires")
	}
	if size := cache.Size(); size != 1 {
		t.Fatalf("size=%d", size)
	}
}

// TestExpiredLeaderCannotPublishIntoTheNextGeneration covers the two ways a
// dead leader could corrupt its successor.
func TestExpiredLeaderCannotPublishIntoTheNextGeneration(t *testing.T) {
	clock := time.Now()
	cache := NewReceiptCacheWithClock(func() time.Time { return clock })
	cache.SetFollowerWait(10 * time.Millisecond)
	key := testReceiptKey("generation")

	leader, stale, _ := cache.Begin(key, time.Second)
	if !leader {
		t.Fatal("expected to lead")
	}
	// The first leader dies without publishing; its entry expires.
	clock = clock.Add(2 * time.Second)

	fresh, freshClaim, _ := cache.Begin(key, time.Second)
	if !fresh {
		t.Fatal("an expired entry must be reclaimable")
	}
	// The dead leader now tries to publish. It must not be able to reach the
	// generation that replaced it.
	cache.Publish(stale, Receipt{Recipients: 9, Delivered: 9, Reason: "stale-outcome"})
	found, current := cache.Lookup(key)
	if !found {
		t.Fatal("the new claim disappeared")
	}
	if current.Reason == "stale-outcome" || current.Delivered == 9 {
		t.Fatalf("a stale leader published into a new generation: %+v", current)
	}
	// The rightful leader still owns the entry.
	cache.Publish(freshClaim, Receipt{Recipients: 1, Delivered: 1})
	if _, result := cache.Lookup(key); result.Delivered != 1 {
		t.Fatalf("the current leader could not publish: %+v", result)
	}
	// And the dead leader cannot abandon the live entry either.
	cache.Abandon(stale, Receipt{Reason: "stale-abandon"})
	if _, result := cache.Lookup(key); result.Delivered != 1 {
		t.Fatalf("a stale leader abandoned a live entry: %+v", result)
	}
}

// TestExpiredLeaderNeverWakesFollowersWithAnEmptyReceipt checks what a follower
// blocked on a leader that never finished actually receives. An empty receipt
// reads as "delivered to nobody", which is a different claim from "unknown".
func TestExpiredLeaderNeverWakesFollowersWithAnEmptyReceipt(t *testing.T) {
	clock := time.Now()
	var clockMu sync.Mutex
	now := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return clock
	}
	cache := NewReceiptCacheWithClock(now)
	cache.SetFollowerWait(time.Second)
	key := testReceiptKey("stuck-leader")

	if leader, _, _ := cache.Begin(key, time.Second); !leader {
		t.Fatal("expected to lead")
	}
	released := make(chan Receipt, 1)
	go func() {
		_, receipt := cache.Lookup(key)
		released <- receipt
	}()

	// Let the follower attach, then expire the leader and force a sweep.
	time.Sleep(20 * time.Millisecond)
	clockMu.Lock()
	clock = clock.Add(2 * time.Second)
	clockMu.Unlock()
	cache.Begin(testReceiptKey("sweep-trigger"), time.Second)

	select {
	case receipt := <-released:
		if receipt.Reason != ReasonInProgress {
			t.Fatalf("follower of an expired leader received %+v, want an explicit in-progress", receipt)
		}
		if receipt.Delivered != 0 || receipt.Recipients != 0 {
			t.Fatalf("follower received a fabricated delivery count: %+v", receipt)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("a follower was never released")
	}
}
