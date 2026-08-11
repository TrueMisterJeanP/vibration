package ws

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"chat-pwa-go/internal/callsig"
	database "chat-pwa-go/internal/db"
)

// recordingRouter stands in for the federation edition. It records what was
// handed to it and lets a test choose the delivery outcome.
type recordingRouter struct {
	mu         sync.Mutex
	dispatched []callsig.Event
	targets    []callsig.Recipient
	reason     string
	localBase  string
}

func (r *recordingRouter) RelayRealtime(int64, int64, map[string]any) bool { return false }
func (r *recordingRouter) RelayPresence(int64, bool)                       {}

func (r *recordingRouter) LocalCallIdentity(userID int64) (callsig.Identity, bool) {
	return callsig.Identity{}, false
}

func (r *recordingRouter) RemoteCallRecipient(userID int64) (callsig.Recipient, bool) {
	return callsig.Recipient{}, false
}

func (r *recordingRouter) DispatchCall(recipient callsig.Recipient, event callsig.Event, report func(callsig.Delivery)) {
	r.mu.Lock()
	r.dispatched = append(r.dispatched, event)
	r.targets = append(r.targets, recipient)
	r.mu.Unlock()
	report(callsig.Delivery{Recipient: recipient, Reason: r.reason})
}

func (r *recordingRouter) calls() ([]callsig.Event, []callsig.Recipient) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]callsig.Event(nil), r.dispatched...), append([]callsig.Recipient(nil), r.targets...)
}

func federatedCallTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db := callSignalTestDB(t)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO federated_instances(id,name,base_url,host,shared_secret,is_active,created_at,updated_at)
		VALUES(1,'Beta','https://beta.example','beta.example','secret',1,?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	// A remote member exists locally only as a shadow row. Its numeric id (4)
	// is deliberately different from the id it carries on its own instance.
	if _, err := db.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,is_remote,remote_instance_id,remote_username,created_at)
		VALUES(4,'carol_remote_1','Carol','hash','public','private','salt',1,1,'carol',?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(2,4,'key','member',?)`, now); err != nil {
		t.Fatal(err)
	}
	return db
}

func newCallHandler(t *testing.T, db *sql.DB, hub *Hub, router *recordingRouter) *Handler {
	t.Helper()
	handler := &Handler{DB: db, Hub: hub, LocalBaseURL: "https://alpha.example"}
	if router != nil {
		handler.Federation = router
	}
	return handler
}

// TestGroupInviteReachesLocalAndRemoteMembers is the regression test for the
// bug where a successful federated relay suppressed local delivery entirely: a
// group with both kinds of member left its local participants unaware of the
// call.
func TestGroupInviteReachesLocalAndRemoteMembers(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	router := &recordingRouter{}
	handler := newCallHandler(t, db, hub, router)
	localPeer := NewClient(2)
	otherLocalPeer := NewClient(3)
	hub.Register(localPeer)
	hub.Register(otherLocalPeer)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeInvite, ConversationID: 2, CallID: "call-group", Media: "video",
	})

	for _, client := range []*Client{localPeer, otherLocalPeer} {
		event := receiveCallEvent(t, client)
		if event["type"] != callsig.TypeInvite || event["call_id"] != "call-group" {
			t.Fatalf("local member missed the group invitation: %#v", event)
		}
		sender, _ := event["sender"].(map[string]any)
		if sender["username"] != "caller" || sender["instance"] != "https://alpha.example" {
			t.Fatalf("unexpected sender identity: %#v", event["sender"])
		}
	}
	dispatched, targets := router.calls()
	if len(dispatched) != 1 {
		t.Fatalf("federated dispatches=%d want 1", len(dispatched))
	}
	if targets[0].Identity.Canonical() != "https://beta.example|carol" {
		t.Fatalf("unexpected federated target: %q", targets[0].Identity.Canonical())
	}
	if dispatched[0].Target != nil {
		t.Fatal("a group invitation must stay a broadcast, not be addressed to one member")
	}
}

// TestTargetedSignalUsesExactlyOneRoute checks the two halves of the routing
// rule: a signal for a local member never leaves the instance, and a signal for
// a remote member is never also handed to the local shadow account, behind
// which no browser is connected.
func TestTargetedSignalUsesExactlyOneRoute(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	router := &recordingRouter{}
	handler := newCallHandler(t, db, hub, router)
	localPeer := NewClient(3)
	remoteShadow := NewClient(4)
	hub.Register(localPeer)
	hub.Register(remoteShadow)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 2, CallID: "call-local", Media: "audio",
		Target: callsig.NewIdentity("https://alpha.example", "group_peer"),
		SDP:    &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})
	event := receiveCallEvent(t, localPeer)
	if event["type"] != callsig.TypeOffer || event["target_user_id"].(float64) != 3 {
		t.Fatalf("targeted local delivery failed: %#v", event)
	}
	if dispatched, _ := router.calls(); len(dispatched) != 0 {
		t.Fatalf("a locally addressed signal was also federated: %d", len(dispatched))
	}

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 2, CallID: "call-remote", Media: "audio",
		Target: callsig.NewIdentity("https://beta.example", "carol"),
		SDP:    &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})
	select {
	case data := <-remoteShadow.Call:
		t.Fatalf("a websocket event was sent to a remote shadow account: %s", data)
	default:
	}
	dispatched, _ := router.calls()
	if len(dispatched) != 1 || dispatched[0].CallID != "call-remote" {
		t.Fatalf("remote dispatches=%#v", dispatched)
	}
	if dispatched[0].Target == nil || dispatched[0].Target.Canonical() != "https://beta.example|carol" {
		t.Fatalf("federated target lost: %#v", dispatched[0].Target)
	}
}

// TestLegacyNumericTargetStillRoutes keeps a client that has not reloaded
// working: the numeric id is resolved against the membership and replaced by
// the canonical identity before the signal travels.
func TestLegacyNumericTargetStillRoutes(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	router := &recordingRouter{}
	handler := newCallHandler(t, db, hub, router)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 2, CallID: "call-legacy", Media: "audio",
		TargetUserID: 4,
		SDP:          &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})
	dispatched, _ := router.calls()
	if len(dispatched) != 1 || dispatched[0].Target == nil ||
		dispatched[0].Target.Canonical() != "https://beta.example|carol" {
		t.Fatalf("legacy numeric target was not translated: %#v", dispatched)
	}
}

func TestSignalToNonMemberIsRefused(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, &recordingRouter{})
	outsider := NewClient(3)
	hub.Register(outsider)

	// User 3 belongs to conversation 2, not to the private conversation 1.
	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 1, CallID: "call-outsider", Media: "audio",
		Target: callsig.NewIdentity("https://alpha.example", "group_peer"),
		SDP:    &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})
	select {
	case data := <-outsider.Call:
		t.Fatalf("signal delivered to a non-member: %s", data)
	default:
	}
}

func TestFederatedFailureReachesTheCaller(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	router := &recordingRouter{reason: callsig.ReasonRecipientOffline}
	handler := newCallHandler(t, db, hub, router)
	caller := NewClient(1)
	hub.Register(caller)

	handler.handleCallSignal(caller, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 2, CallID: "call-offline", Media: "audio",
		Target: callsig.NewIdentity("https://beta.example", "carol"),
		SDP:    &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})

	event := receiveCallEvent(t, caller)
	if event["type"] != callsig.TypeFailed || event["reason"] != callsig.ReasonRecipientOffline {
		t.Fatalf("unexpected failure event: %#v", event)
	}
	if event["signal_type"] != callsig.TypeOffer || event["call_id"] != "call-offline" {
		t.Fatalf("failure lost its context: %#v", event)
	}
	if event["event_id"] == "" || event["event_id"] == nil {
		t.Fatalf("failure carries no event id: %#v", event)
	}
	target, _ := event["target"].(map[string]any)
	if target["username"] != "carol" || target["instance"] != "https://beta.example" {
		t.Fatalf("failure target lost: %#v", event["target"])
	}
}

// TestHangupFailureIsNotReported keeps an ordinary end-of-call quiet: the call
// is over on this side either way, and an error toast after the user hung up
// helps nobody.
func TestHangupFailureIsNotReported(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, &recordingRouter{reason: callsig.ReasonTransport})
	caller := NewClient(1)
	hub.Register(caller)

	handler.handleCallSignal(caller, inboundEvent{
		Type: callsig.TypeHangup, ConversationID: 2, CallID: "call-over", Media: "audio",
		Target: callsig.NewIdentity("https://beta.example", "carol"),
	})
	select {
	case data := <-caller.Call:
		t.Fatalf("a failed hangup was reported to its own sender: %s", data)
	default:
	}
}

func TestDuplicateAndExpiredSignalsAreDropped(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, nil)
	receiver := NewClient(2)
	hub.Register(receiver)

	frame := inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 1, CallID: "call-dup", Media: "audio", EventID: "fixed-event",
		SDP: &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	}
	handler.handleCallSignal(&Client{UserID: 1}, frame)
	receiveCallEvent(t, receiver)

	handler.handleCallSignal(&Client{UserID: 1}, frame)
	select {
	case data := <-receiver.Call:
		t.Fatalf("duplicate signal delivered twice: %s", data)
	default:
	}
}

func TestOfflineLocalRecipientIsReported(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, nil)
	caller := NewClient(1)
	hub.Register(caller)

	handler.handleCallSignal(caller, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 1, CallID: "call-nobody", Media: "audio",
		SDP: &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})
	event := receiveCallEvent(t, caller)
	if event["type"] != callsig.TypeFailed || event["reason"] != callsig.ReasonRecipientOffline {
		t.Fatalf("unexpected failure for an offline local peer: %#v", event)
	}
}

func TestSaturatedLocalQueueIsReportedAsQueueFull(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, nil)
	caller := NewClient(1)
	receiver := NewClient(2)
	hub.Register(caller)
	hub.Register(receiver)
	for len(receiver.Call) < cap(receiver.Call) {
		receiver.Call <- []byte(`{"type":"filler"}`)
	}

	handler.handleCallSignal(caller, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 1, CallID: "call-saturated", Media: "audio",
		SDP: &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})
	event := receiveCallEvent(t, caller)
	if event["reason"] != callsig.ReasonQueueFull {
		t.Fatalf("a saturated queue was reported as %q", event["reason"])
	}
}

// TestLocalCallsCarryVersionedEnvelope guards the non-federated path: a call
// between two users of the same instance must keep working and must use the
// same protocol as a federated one.
func TestLocalCallsCarryVersionedEnvelope(t *testing.T) {
	db := callSignalTestDB(t)
	hub := NewHub()
	handler := &Handler{DB: db, Hub: hub}
	receiver := NewClient(2)
	hub.Register(receiver)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 1, CallID: "call-local-only", Media: "audio",
		SDP: &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})
	event := receiveCallEvent(t, receiver)
	if event["version"] != callsig.Version {
		t.Fatalf("local call is not versioned: %#v", event)
	}
	sender, _ := event["sender"].(map[string]any)
	if sender["instance"] != callsig.LocalInstance || sender["username"] != "caller" {
		t.Fatalf("local sender identity=%#v", sender)
	}
	if event["expires_at"] == nil || event["event_id"] == nil {
		t.Fatalf("local call event lacks expiry or id: %#v", event)
	}
	var payload struct {
		SDP callsig.SessionDescription `json:"sdp"`
	}
	raw, _ := json.Marshal(event)
	if json.Unmarshal(raw, &payload) != nil || payload.SDP.SDP != "v=0" {
		t.Fatalf("session description lost: %#v", event["sdp"])
	}
}

func TestInvitationRateLimitIsReported(t *testing.T) {
	db := callSignalTestDB(t)
	hub := NewHub()
	handler := &Handler{DB: db, Hub: hub}
	caller := NewClient(1)
	hub.Register(caller)
	drain := func() {
		for len(caller.Call) > 0 {
			<-caller.Call
		}
	}

	limited := false
	for attempt := 0; attempt < 30 && !limited; attempt++ {
		drain()
		handler.handleCallSignal(caller, inboundEvent{
			Type: callsig.TypeInvite, ConversationID: 1, CallID: "call-flood", Media: "audio",
		})
		for len(caller.Call) > 0 {
			var event map[string]any
			if json.Unmarshal(<-caller.Call, &event) == nil && event["reason"] == callsig.ReasonRateLimit {
				limited = true
			}
		}
	}
	if !limited {
		t.Fatal("invitation flooding was never rate limited")
	}
}

func TestMigratedDatabaseAllowsSeveralFederatedInstancesPerConversation(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
		VALUES(1,'owner','Owner','hash','public','private','salt',?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO conversations(id,type,created_by,created_at) VALUES(1,'group',1,?)`, now); err != nil {
		t.Fatal(err)
	}
	for id, host := range map[int64]string{1: "https://beta.example", 2: "https://gamma.example"} {
		if _, err := db.Exec(`INSERT INTO federated_instances(id,name,base_url,host,shared_secret,is_active,created_at,updated_at)
			VALUES(?,?,?,?,'secret',1,?,?)`, id, host, host, host, now, now); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO federated_conversations(local_conversation_id,instance_id,remote_conversation_id,local_user_id,remote_user_id,federation_key_id,created_at)
			VALUES(1,?,?,1,1,?,?)`, id, -id, "key-"+host, now); err != nil {
			t.Fatalf("second federated destination refused: %v", err)
		}
	}
	var rows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM federated_conversations WHERE local_conversation_id=1`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("federated destinations=%d err=%v", rows, err)
	}
}

// TestCandidatesBeforeOfferAreRelayedNotDropped checks the server side of the
// early-candidate case. Buffering belongs to the browser; the server's job is
// simply to relay a candidate that arrives first rather than deciding it is out
// of order.
func TestCandidatesBeforeOfferAreRelayedNotDropped(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, nil)
	receiver := NewClient(2)
	hub.Register(receiver)

	// A candidate carrying a *lower* sequence than the offer that follows: this
	// is exactly what a burst of trickled candidates looks like when it
	// overtakes the description it belongs to.
	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeCandidate, ConversationID: 1, CallID: "call-early", Sequence: 1,
		Candidate: &callsig.IceCandidate{Candidate: "candidate:early"},
	})
	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 1, CallID: "call-early", Sequence: 5,
		SDP: &callsig.SessionDescription{Type: "offer", SDP: "v=0"},
	})
	// A candidate that lands after the offer with an older sequence must still
	// be relayed: candidates describe independent paths and dropping one costs
	// a usable route.
	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeCandidate, ConversationID: 1, CallID: "call-early", Sequence: 2,
		Candidate: &callsig.IceCandidate{Candidate: "candidate:late"},
	})

	types := []string{}
	for received := 0; received < 3; received++ {
		types = append(types, receiveCallEvent(t, receiver)["type"].(string))
	}
	expected := []string{callsig.TypeCandidate, callsig.TypeOffer, callsig.TypeCandidate}
	for index, want := range expected {
		if types[index] != want {
			t.Fatalf("relayed order=%v want %v", types, expected)
		}
	}
}

// TestSequencesAreIndependentPerParticipant is the group regression: a signal
// addressed to one member must not make a lower-numbered signal addressed to
// another member look stale, which would silently strand that second peer.
func TestSequencesAreIndependentPerParticipant(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, &recordingRouter{})
	second := NewClient(2)
	third := NewClient(3)
	hub.Register(second)
	hub.Register(third)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 2, CallID: "call-seq", Sequence: 9,
		Target: callsig.NewIdentity("https://alpha.example", "callee"),
		SDP:    &callsig.SessionDescription{Type: "offer", SDP: "v=0 to-callee"},
	})
	if event := receiveCallEvent(t, second); event["type"] != callsig.TypeOffer {
		t.Fatalf("first offer not delivered: %#v", event)
	}

	// A far lower sequence, addressed to a different participant.
	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 2, CallID: "call-seq", Sequence: 1,
		Target: callsig.NewIdentity("https://alpha.example", "group_peer"),
		SDP:    &callsig.SessionDescription{Type: "offer", SDP: "v=0 to-group-peer"},
	})
	event := receiveCallEvent(t, third)
	description, _ := event["sdp"].(map[string]any)
	if event["type"] != callsig.TypeOffer || description["sdp"] != "v=0 to-group-peer" {
		t.Fatalf("an offer to a second participant was judged stale against the first: %#v", event)
	}

	// The addressee's own sequence still applies: an older offer to the same
	// participant is stale and must be dropped.
	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 2, CallID: "call-seq", Sequence: 2,
		Target: callsig.NewIdentity("https://alpha.example", "callee"),
		SDP:    &callsig.SessionDescription{Type: "offer", SDP: "v=0 stale"},
	})
	select {
	case data := <-second.Call:
		t.Fatalf("a stale offer to the same participant was relayed: %s", data)
	default:
	}
}

// TestOfferAfterHangupIsRefused covers the tombstone: a fresh event id makes a
// late offer invisible to deduplication, so only the record that the call ended
// can stop it.
func TestOfferAfterHangupIsRefused(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, nil)
	receiver := NewClient(2)
	hub.Register(receiver)

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeHangup, ConversationID: 1, CallID: "call-over", Sequence: 5,
	})
	if event := receiveCallEvent(t, receiver); event["type"] != callsig.TypeHangup {
		t.Fatalf("hangup not relayed: %#v", event)
	}

	handler.handleCallSignal(&Client{UserID: 1}, inboundEvent{
		Type: callsig.TypeOffer, ConversationID: 1, CallID: "call-over", Sequence: 6,
		EventID: "brand-new-event-id",
		SDP:     &callsig.SessionDescription{Type: "offer", SDP: "v=0 too-late"},
	})
	select {
	case data := <-receiver.Call:
		t.Fatalf("an offer was relayed after the call ended: %s", data)
	default:
	}
}

// TestInconsistentDescriptionsAreRefusedAtTheSocket keeps the same rule at the
// browser boundary as at the federated one: a signal may only carry the payload
// its type implies.
func TestInconsistentDescriptionsAreRefusedAtTheSocket(t *testing.T) {
	db := federatedCallTestDB(t)
	hub := NewHub()
	handler := newCallHandler(t, db, hub, nil)
	receiver := NewClient(2)
	hub.Register(receiver)

	for _, event := range []inboundEvent{
		{Type: callsig.TypeOffer, ConversationID: 1, CallID: "c1", SDP: &callsig.SessionDescription{Type: "answer", SDP: "v=0"}},
		{Type: callsig.TypeAnswer, ConversationID: 1, CallID: "c2", SDP: &callsig.SessionDescription{Type: "offer", SDP: "v=0"}},
		{Type: callsig.TypeInvite, ConversationID: 1, CallID: "c3", SDP: &callsig.SessionDescription{Type: "offer", SDP: "v=0"}},
		{Type: callsig.TypeHangup, ConversationID: 1, CallID: "c4", Candidate: &callsig.IceCandidate{Candidate: "candidate:1"}},
	} {
		handler.handleCallSignal(&Client{UserID: 1}, event)
	}
	select {
	case data := <-receiver.Call:
		t.Fatalf("an inconsistent signal was relayed: %s", data)
	default:
	}
}
