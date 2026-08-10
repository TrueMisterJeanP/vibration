package ws

import (
	"encoding/json"
	"testing"
)

// TestDurableEventClosesSaturatedConnectionInsteadOfDroppingIt is the core
// backpressure guarantee: a new message, a role change or a revocation is never
// discarded in silence. When the queue is full the socket is closed so the
// client reconnects and re-reads the persisted state.
func TestDurableEventClosesSaturatedConnectionInsteadOfDroppingIt(t *testing.T) {
	hub := NewHub()
	client := NewClient(1)
	hub.Register(client)
	fillQueue(client)

	if hub.SendToUser(1, map[string]any{"type": "new_message"}) {
		t.Fatal("a saturated connection must not report the event as delivered")
	}
	select {
	case <-client.Done:
	default:
		t.Fatal("a durable event that does not fit must close the connection so the client resyncs")
	}
	if !client.resync.Load() {
		t.Fatal("the closure must be marked as a resync, not as a policy violation")
	}
	if client.policyClose.Load() {
		t.Fatal("backpressure must not masquerade as an authorization close")
	}
	if hub.Stats().ForcedResyncs != 1 {
		t.Fatalf("forced resyncs=%d, want 1", hub.Stats().ForcedResyncs)
	}
}

// TestEphemeralEventIsDroppedWithoutClosing checks the other half: typing and
// presence are allowed to disappear under pressure, and must never cost the
// user their connection.
func TestEphemeralEventIsDroppedWithoutClosing(t *testing.T) {
	hub := NewHub()
	client := NewClient(1)
	hub.Register(client)
	fillQueue(client)

	if hub.SendEphemeralToUser(1, map[string]any{"type": "typing"}) {
		t.Fatal("an ephemeral event on a saturated connection must not be reported as delivered")
	}
	select {
	case <-client.Done:
		t.Fatal("an ephemeral event must never close the connection")
	default:
	}
	if hub.Stats().DroppedEvents != 1 {
		t.Fatalf("dropped ephemeral events=%d, want 1", hub.Stats().DroppedEvents)
	}
}

// TestEphemeralEventsYieldHeadroomToDurableOnes shows the reservation working:
// once typing traffic has filled half the queue it is refused, while the
// remaining half stays available for messages.
func TestEphemeralEventsYieldHeadroomToDurableOnes(t *testing.T) {
	hub := NewHub()
	client := NewClient(1)
	hub.Register(client)

	accepted := 0
	for index := 0; index < clientQueueSize; index++ {
		if hub.SendEphemeralToUser(1, map[string]any{"type": "typing", "n": index}) {
			accepted++
		}
	}
	if accepted != ephemeralQueueLimit {
		t.Fatalf("accepted %d ephemeral events, want the %d-slot watermark", accepted, ephemeralQueueLimit)
	}
	if !hub.SendToUser(1, map[string]any{"type": "new_message"}) {
		t.Fatal("a durable event must still fit in the reserved headroom")
	}
	select {
	case <-client.Done:
		t.Fatal("the connection must stay open while headroom remains")
	default:
	}
}

func TestDurableEventIsDeliveredToEveryConnectionOfTheUser(t *testing.T) {
	hub := NewHub()
	phone, laptop := NewClient(7), NewClient(7)
	hub.Register(phone)
	hub.Register(laptop)

	if !hub.SendToUser(7, map[string]any{"type": "new_message", "id": 42}) {
		t.Fatal("the event must be delivered")
	}
	for name, client := range map[string]*Client{"phone": phone, "laptop": laptop} {
		select {
		case data := <-client.Send:
			var event map[string]any
			if err := json.Unmarshal(data, &event); err != nil {
				t.Fatal(err)
			}
			if event["type"] != "new_message" {
				t.Fatalf("%s received %#v", name, event)
			}
		default:
			t.Fatalf("%s did not receive the event", name)
		}
	}
}

// TestKickClosesWithPolicyWhenTheKickQueueIsFull keeps revocation enforcement
// intact: a second kick must still tear the connection down.
func TestKickClosesWithPolicyWhenTheKickQueueIsFull(t *testing.T) {
	hub := NewHub()
	client := NewClient(3)
	hub.Register(client)

	hub.KickUser(3, map[string]any{"type": "sessions_changed"})
	hub.KickUser(3, map[string]any{"type": "sessions_changed"})
	select {
	case <-client.Done:
	default:
		t.Fatal("a kick that cannot be queued must still close the connection")
	}
	if !client.policyClose.Load() {
		t.Fatal("a kick must close with a policy violation so the client does not simply reconnect")
	}
}

func TestUnregisterKeepsConnectionCountAccurate(t *testing.T) {
	hub := NewHub()
	client := NewClient(5)
	hub.Register(client)
	if hub.Stats().Connections != 1 {
		t.Fatalf("connections=%d after register, want 1", hub.Stats().Connections)
	}
	hub.Unregister(client)
	if hub.Stats().Connections != 0 {
		t.Fatalf("connections=%d after unregister, want 0", hub.Stats().Connections)
	}
	// A duplicate unregister must not drive the counter negative.
	hub.Unregister(client)
	if hub.Stats().Connections != 0 {
		t.Fatalf("connections=%d after a repeated unregister, want 0", hub.Stats().Connections)
	}
}

func fillQueue(client *Client) {
	for len(client.Send) < cap(client.Send) {
		client.Send <- []byte(`{"type":"filler"}`)
	}
}

// A saturated connection must be counted once, not once per event that arrives
// while the reader has yet to notice.
func TestForcedResyncIsCountedOncePerConnection(t *testing.T) {
	hub := NewHub()
	client := NewClient(9)
	hub.Register(client)
	fillQueue(client)

	for attempt := 0; attempt < 5; attempt++ {
		hub.SendToUser(9, map[string]any{"type": "new_message", "n": attempt})
	}
	if got := hub.Stats().ForcedResyncs; got != 1 {
		t.Fatalf("forced resyncs=%d, want exactly 1 for one saturated connection", got)
	}
}

func TestCallSignalUsesDedicatedQueueWhenDurableQueueIsFull(t *testing.T) {
	hub := NewHub()
	client := NewClient(10)
	hub.Register(client)
	fillQueue(client)

	if !hub.SendCallToUser(10, map[string]any{"type": "call_offer"}) {
		t.Fatal("call signal was crowded out by the durable event queue")
	}
	select {
	case data := <-client.Call:
		var event map[string]any
		if err := json.Unmarshal(data, &event); err != nil || event["type"] != "call_offer" {
			t.Fatalf("unexpected call event=%#v err=%v", event, err)
		}
	default:
		t.Fatal("call signal was not queued")
	}
	select {
	case <-client.Done:
		t.Fatal("a call signal must not force a misleading database resync")
	default:
	}
}

func TestFullCallQueueReportsFailureWithoutClosingSocket(t *testing.T) {
	hub := NewHub()
	client := NewClient(11)
	hub.Register(client)
	for len(client.Call) < cap(client.Call) {
		client.Call <- []byte(`{"type":"filler"}`)
	}

	if hub.SendCallToUser(11, map[string]any{"type": "ice_candidate"}) {
		t.Fatal("full call queue reported a delivery")
	}
	if got := hub.Stats().FailedCallSignals; got != 1 {
		t.Fatalf("failed call signals=%d, want 1", got)
	}
	select {
	case <-client.Done:
		t.Fatal("full call queue must report failure without closing the socket")
	default:
	}
}
