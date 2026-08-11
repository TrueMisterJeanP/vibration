package callsig

import (
	"sync"
	"testing"
	"time"
)

func dispatchEvent(callID, eventType string, sequence int64) Event {
	event := Event{
		EventID: callID + "-" + eventType + "-" + FormatTime(time.Now()) + "-" + string(rune('a'+sequence)),
		CallID:  callID, Sequence: sequence, Type: eventType, Media: "audio",
		Sender: NewIdentity("https://alpha.example", "alice"),
	}
	event.Normalize(time.Now())
	return event
}

// TestDispatcherKeepsOneStreamInOrder is the deterministic version of the
// reordering that strands a call: delivery of the first event is held open, and
// the second must not start until it finishes.
func TestDispatcherKeepsOneStreamInOrder(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	started := []string{}
	finished := []string{}

	dispatcher := NewDispatcher(func(job Job) Delivery {
		mu.Lock()
		started = append(started, job.Event.Type)
		first := len(started) == 1
		mu.Unlock()
		if first {
			<-release
		}
		mu.Lock()
		finished = append(finished, job.Event.Type)
		mu.Unlock()
		return Delivery{Recipient: job.Recipient}
	})

	key := StreamKey{InstanceID: 1, Sender: "https://alpha.example|alice", CallID: "call-1"}
	for _, eventType := range []string{TypeAccept, TypeOffer} {
		event := dispatchEvent("call-1", eventType, 1)
		dispatcher.Submit(Job{Key: key, Event: event, Report: func(Delivery) {}})
	}

	// While the first delivery is held, the second must not have begun. This is
	// what distinguishes real serialization from a race that happened to win.
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	inFlight := append([]string(nil), started...)
	mu.Unlock()
	if len(inFlight) != 1 || inFlight[0] != TypeAccept {
		t.Fatalf("second delivery started before the first finished: %v", inFlight)
	}

	close(release)
	if !dispatcher.WaitIdle(2 * time.Second) {
		t.Fatal("dispatcher did not drain")
	}
	mu.Lock()
	order := append([]string(nil), finished...)
	mu.Unlock()
	if len(order) != 2 || order[0] != TypeAccept || order[1] != TypeOffer {
		t.Fatalf("delivery order=%v", order)
	}
}

// TestDispatcherRunsDistinctStreamsInParallel checks the other half of the
// rule: serializing everything would let one unreachable instance delay every
// other call on the server.
func TestDispatcherRunsDistinctStreamsInParallel(t *testing.T) {
	release := make(chan struct{})
	var running sync.WaitGroup
	started := make(chan string, 2)
	running.Add(2)

	dispatcher := NewDispatcher(func(job Job) Delivery {
		started <- job.Key.CallID
		running.Done()
		<-release
		return Delivery{Recipient: job.Recipient}
	})
	for _, callID := range []string{"call-a", "call-b"} {
		dispatcher.Submit(Job{
			Key:    StreamKey{InstanceID: 1, Sender: "https://alpha.example|alice", CallID: callID},
			Event:  dispatchEvent(callID, TypeOffer, 1),
			Report: func(Delivery) {},
		})
	}

	done := make(chan struct{})
	go func() { running.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("two independent calls were serialized against each other")
	}
	close(release)
	if !dispatcher.WaitIdle(2 * time.Second) {
		t.Fatal("dispatcher did not drain")
	}
	if streams := dispatcher.Streams(); streams != 0 {
		t.Fatalf("dispatcher leaked %d streams", streams)
	}
}

func TestDispatcherReportsQueueFullAndReleasesStreams(t *testing.T) {
	release := make(chan struct{})
	dispatcher := NewDispatcher(func(job Job) Delivery {
		<-release
		return Delivery{Recipient: job.Recipient}
	})
	key := StreamKey{InstanceID: 1, Sender: "https://alpha.example|alice", CallID: "call-flood"}

	var mu sync.Mutex
	refused := 0
	for index := 0; index < DispatchStreamDepth+8; index++ {
		dispatcher.Submit(Job{
			Key: key, Event: dispatchEvent("call-flood", TypeCandidate, 1),
			Report: func(delivery Delivery) {
				if delivery.Reason == ReasonQueueFull {
					mu.Lock()
					refused++
					mu.Unlock()
				}
			},
		})
	}
	mu.Lock()
	total := refused
	mu.Unlock()
	if total == 0 {
		t.Fatal("an over-deep stream must refuse work rather than grow without bound")
	}
	close(release)
	if !dispatcher.WaitIdle(3 * time.Second) {
		t.Fatal("dispatcher did not drain")
	}
	if pending := dispatcher.Pending(); pending != 0 {
		t.Fatalf("pending=%d after draining", pending)
	}
	if streams := dispatcher.Streams(); streams != 0 {
		t.Fatalf("dispatcher leaked %d streams", streams)
	}
}

// TestDispatcherDropsEventsThatExpiredWhileQueued keeps a stale offer off the
// wire: an event that waited behind its predecessors past its own expiry
// describes transport candidates that no longer exist.
func TestDispatcherDropsEventsThatExpiredWhileQueued(t *testing.T) {
	var clockMu sync.Mutex
	clock := time.Now()
	now := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return clock
	}
	release := make(chan struct{})
	started := make(chan struct{}, 1)
	dispatcher := NewDispatcherWithClock(func(job Job) Delivery {
		started <- struct{}{}
		<-release
		return Delivery{Recipient: job.Recipient}
	}, now)

	key := StreamKey{InstanceID: 1, Sender: "https://alpha.example|alice", CallID: "call-expiry"}
	reasons := make(chan string, 2)
	for index := 0; index < 2; index++ {
		dispatcher.Submit(Job{
			Key: key, Event: dispatchEvent("call-expiry", TypeOffer, int64(index+1)),
			Report: func(delivery Delivery) { reasons <- delivery.Reason },
		})
	}
	// Wait until the first delivery is genuinely under way — its own expiry
	// check has therefore already passed — then move time past the TTL window
	// so only the queued second event can expire.
	<-started
	clockMu.Lock()
	clock = clock.Add(DefaultTTL + MaxClockSkew + time.Second)
	clockMu.Unlock()
	close(release)

	first := <-reasons
	second := <-reasons
	if first != ReasonDelivered {
		t.Fatalf("first event reason=%q", first)
	}
	if second != ReasonExpired {
		t.Fatalf("an event that expired while queued was still sent: reason=%q", second)
	}
}

// TestDispatcherSeparatesConversationsSharingACallID is the conversation-scope
// regression. Call ids are chosen by clients, so the same one appears in
// unrelated conversations; without the conversation in the key those two flows
// share a queue, and a peer that is slow in one conversation stalls the other.
func TestDispatcherSeparatesConversationsSharingACallID(t *testing.T) {
	release := make(chan struct{})
	started := make(chan int64, 2)
	dispatcher := NewDispatcher(func(job Job) Delivery {
		started <- job.Key.ConversationID
		<-release
		return Delivery{Recipient: job.Recipient}
	})

	// Same instance, same sender, same call id — only the conversation differs.
	for _, conversationID := range []int64{11, 22} {
		dispatcher.Submit(Job{
			Key: StreamKey{
				InstanceID: 1, ConversationID: conversationID,
				Sender: "https://alpha.example|alice", CallID: "shared-call-id",
			},
			Event:  dispatchEvent("shared-call-id", TypeOffer, 1),
			Report: func(Delivery) {},
		})
	}

	seen := map[int64]bool{}
	for received := 0; received < 2; received++ {
		select {
		case conversationID := <-started:
			seen[conversationID] = true
		case <-time.After(2 * time.Second):
			t.Fatalf("a blocked conversation delayed an unrelated one: started=%v", seen)
		}
	}
	if !seen[11] || !seen[22] {
		t.Fatalf("both conversations must run in parallel: %v", seen)
	}
	close(release)
	if !dispatcher.WaitIdle(2 * time.Second) {
		t.Fatal("dispatcher did not drain")
	}
	if streams := dispatcher.Streams(); streams != 0 {
		t.Fatalf("dispatcher leaked %d streams", streams)
	}
}

// TestDispatcherLimitsAreExactlyAsDocumented pins the numbers the comment
// promises, so the documented ceiling cannot drift from the enforced one.
func TestDispatcherLimitsAreExactlyAsDocumented(t *testing.T) {
	release := make(chan struct{})
	var inFlight sync.WaitGroup
	dispatcher := NewDispatcher(func(job Job) Delivery {
		inFlight.Done()
		<-release
		return Delivery{Recipient: job.Recipient}
	})

	// One job per stream, up to the stream ceiling: each becomes in-flight.
	inFlight.Add(DispatchMaxStreams)
	for index := 0; index < DispatchMaxStreams; index++ {
		dispatcher.Submit(Job{
			Key: StreamKey{
				InstanceID: 1, ConversationID: int64(index),
				Sender: "https://alpha.example|alice", CallID: "call",
			},
			Event:  dispatchEvent("call", TypeOffer, 1),
			Report: func(Delivery) {},
		})
	}
	inFlight.Wait()

	// A stream beyond the ceiling is refused rather than created.
	refused := make(chan string, 1)
	dispatcher.Submit(Job{
		Key: StreamKey{
			InstanceID: 1, ConversationID: 9999,
			Sender: "https://alpha.example|alice", CallID: "call",
		},
		Event:  dispatchEvent("call", TypeOffer, 1),
		Report: func(delivery Delivery) { refused <- delivery.Reason },
	})
	select {
	case reason := <-refused:
		if reason != ReasonQueueFull {
			t.Fatalf("stream ceiling reason=%q", reason)
		}
	case <-time.After(time.Second):
		t.Fatal("a job beyond the stream ceiling was neither run nor refused")
	}
	if streams := dispatcher.Streams(); streams > DispatchMaxStreams {
		t.Fatalf("streams=%d exceeded %d", streams, DispatchMaxStreams)
	}

	close(release)
	if !dispatcher.WaitIdle(5 * time.Second) {
		t.Fatal("dispatcher did not drain")
	}
}
