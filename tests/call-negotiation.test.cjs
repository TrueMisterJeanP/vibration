const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "web/js/call-negotiation.js"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");

async function loadModule() {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

(async () => {
  const negotiation = await loadModule();
  const {
    PeerNegotiation,
    callIdentity,
    callRTCConfigurationFrom,
    canonicalCallIdentity,
    createCallSequencer,
    createCallSignalLedger,
    createPendingCandidateQueue,
    iceTransportPolicy,
    isPoliteCallPeer,
    parseCallIdentity,
    sameCallIdentity,
    shouldOfferAfterAccept,
    shouldOfferInGroup,
    supportsFederatedCalls,
  } = negotiation;

  // --- Canonical identity -------------------------------------------------
  assert.equal(
    canonicalCallIdentity(callIdentity("https://Alpha.Example/", "Alice")),
    "https://alpha.example|alice",
    "instance and username must be normalized",
  );
  assert.equal(
    canonicalCallIdentity(callIdentity("https://alpha.example:443", "alice")),
    "https://alpha.example|alice",
    "the default https port must be dropped",
  );
  assert.equal(
    canonicalCallIdentity(callIdentity("https://alpha.example:8443/", "alice")),
    "https://alpha.example:8443|alice",
    "a non-default port is part of the identity",
  );
  assert.equal(canonicalCallIdentity(callIdentity("", "alice")), "local|alice");
  assert.equal(parseCallIdentity("alice"), null, "a bare username is not an identity");
  assert.deepEqual(parseCallIdentity("https://alpha.example|alice"), {
    instance: "https://alpha.example",
    username: "alice",
  });
  assert.ok(sameCallIdentity(callIdentity("https://ALPHA.example/", "Alice"), callIdentity("https://alpha.example", "alice")));

  // --- Exactly one initiator per pair, whatever the local ids are ----------
  const alice = callIdentity("https://alpha.example", "alice");
  const bob = callIdentity("https://beta.example", "bob");
  assert.notEqual(
    isPoliteCallPeer(alice, bob),
    isPoliteCallPeer(bob, alice),
    "both peers reached the same politeness verdict",
  );
  assert.notEqual(
    shouldOfferInGroup(alice, bob),
    shouldOfferInGroup(bob, alice),
    "a group pair must produce exactly one offer",
  );
  // The same participants spelled differently must not flip the verdict.
  assert.equal(
    isPoliteCallPeer(callIdentity("https://ALPHA.example/", "Alice"), bob),
    isPoliteCallPeer(alice, bob),
  );

  // --- Private calls follow the call direction, not any identifier --------
  assert.equal(shouldOfferAfterAccept({ direction: "outgoing" }), true, "the caller offers");
  assert.equal(shouldOfferAfterAccept({ direction: "incoming" }), false, "the callee waits for the offer");
  // A→B and B→A must behave identically: in both cases exactly the caller offers.
  const callAtoB = { direction: "outgoing" };
  const callBtoA = { direction: "incoming" };
  assert.equal(
    Number(shouldOfferAfterAccept(callAtoB)) + Number(shouldOfferAfterAccept(callBtoA)),
    1,
    "exactly one side of a private call creates the offer",
  );

  // --- Perfect negotiation ------------------------------------------------
  const impolite = new PeerNegotiation(bob, alice); // "https://beta…" > "https://alpha…"
  const polite = new PeerNegotiation(alice, bob);
  assert.equal(impolite.polite, false);
  assert.equal(polite.polite, true);

  // No collision: both accept the offer normally.
  assert.deepEqual(impolite.evaluateDescription({ type: "offer" }, "stable"), { ignore: false, rollback: false });
  assert.deepEqual(polite.evaluateDescription({ type: "offer" }, "stable"), { ignore: false, rollback: false });

  // Glare: both created an offer at the same time.
  impolite.beginOffer();
  polite.beginOffer();
  const impoliteVerdict = impolite.evaluateDescription({ type: "offer" }, "have-local-offer");
  const politeVerdict = polite.evaluateDescription({ type: "offer" }, "have-local-offer");
  assert.deepEqual(impoliteVerdict, { ignore: true, rollback: false }, "the impolite peer discards the colliding offer");
  assert.deepEqual(politeVerdict, { ignore: false, rollback: true }, "the polite peer rolls back and answers");
  assert.equal(impolite.mayDropCandidate(), true, "candidates of an ignored offer may be dropped");
  impolite.endOffer();
  polite.endOffer();

  // An answer in flight still counts as ready: the state is momentarily not
  // "stable" but the peer is not making an offer.
  polite.beginRemoteAnswer();
  assert.deepEqual(
    polite.evaluateDescription({ type: "offer" }, "have-local-offer"),
    { ignore: false, rollback: false },
    "a pending remote answer must not be mistaken for a collision",
  );
  polite.endRemoteAnswer();

  // --- Deduplication, expiry and ordering ---------------------------------
  let clock = Date.parse("2026-08-10T12:00:00.000Z");
  const ledger = createCallSignalLedger({ now: () => clock });
  const event = (id, sequence, type = "call_offer", ttlMs = 30_000) => ({
    event_id: id,
    conversation_id: 1,
    call_id: "call-1",
    sequence,
    type,
    sender: alice,
    expires_at: new Date(clock + ttlMs).toISOString(),
  });

  assert.deepEqual(ledger.accept(event("e1", 3)), { ok: true, reason: "" });
  assert.equal(ledger.accept(event("e1", 3)).reason, "duplicate", "a replayed signal must be dropped");
  assert.equal(ledger.accept(event("e0", 1)).reason, "stale", "an offer older than one already applied is stale");
  assert.equal(
    ledger.accept(event("e2", 1, "ice_candidate")).ok,
    true,
    "a late ICE candidate is not stale: candidates are order independent",
  );

  const late = event("e3", 9);
  clock += 30_000 + 30_000 + 1_000; // past the TTL and the tolerated skew
  assert.equal(ledger.accept(late).reason, "expired", "an expired signal must be dropped");

  // forget() erases every trace, tombstone included: only for a call that
  // must not be refused afterwards.
  ledger.forget({ conversationID: 1, sender: alice, callID: "call-1" });
  assert.equal(ledger.accept(event("e4", 1)).ok, true, "a new call may restart its sequence");

  const sequencer = createCallSequencer();
  const counter = (callID, target, conversationID = 1) =>
    sequencer.next({ conversationID, sender: alice, callID, target });
  assert.equal(counter("call-a"), 1);
  assert.equal(counter("call-a"), 2);
  assert.equal(counter("call-b"), 1, "sequences are per call");
  assert.equal(counter("call-a", undefined, 2), 1, "sequences are per conversation");
  sequencer.forget({ conversationID: 1, sender: alice, callID: "call-a" });
  assert.equal(counter("call-a"), 1);

  // --- Sequences are scoped per addressee, not merely per call ------------
  // In a group, a signal sent to one participant must not consume the counter
  // that a signal to another participant is judged against.
  const carol = callIdentity("https://gamma.example", "carol");
  const grouped = createCallSequencer();
  const group = (target) => grouped.next({ conversationID: 7, sender: alice, callID: "call-g", target });
  assert.equal(group(bob), 1);
  assert.equal(group(carol), 1, "each addressee has its own sequence");
  assert.equal(group(bob), 2);
  assert.equal(group(undefined), 1, "a broadcast has its own sequence too");

  let groupClock = Date.parse("2026-08-10T12:00:00.000Z");
  const groupLedger = createCallSignalLedger({ now: () => groupClock });
  const addressed = (id, sequence, target) => ({
    event_id: id, conversation_id: 7, call_id: "call-g", sequence, type: "call_offer", sender: alice, target,
    expires_at: new Date(groupClock + 30_000).toISOString(),
  });
  assert.equal(groupLedger.accept(addressed("g1", 5, bob)).ok, true);
  assert.equal(
    groupLedger.accept(addressed("g2", 1, carol)).ok,
    true,
    "a low-numbered signal to another participant must not be judged stale",
  );
  assert.equal(groupLedger.accept(addressed("g3", 2, bob)).reason, "stale", "the addressee's own sequence still applies");

  // --- A call that ended stays ended, even for an unseen event id ---------
  let endedClock = Date.parse("2026-08-10T12:00:00.000Z");
  const endedLedger = createCallSignalLedger({ now: () => endedClock });
  const forCall = (id, type, sequence) => ({
    event_id: id, conversation_id: 3, call_id: "call-over", sequence, type, sender: alice,
    expires_at: new Date(endedClock + 30_000).toISOString(),
  });
  assert.equal(endedLedger.accept(forCall("o1", "call_offer", 1)).ok, true);
  assert.equal(endedLedger.accept(forCall("o2", "call_hangup", 2)).ok, true);
  assert.equal(
    endedLedger.accept(forCall("never-seen-before", "call_offer", 3)).reason,
    "call_ended",
    "an offer with a fresh event id must still be refused after the hangup",
  );

  // --- Candidates arriving before the offer -------------------------------
  const pending = createPendingCandidateQueue(3);
  for (const candidate of ["a", "b", "c", "d"]) pending.push(candidate);
  assert.equal(pending.size, 3, "the pending queue must stay bounded");
  assert.deepEqual(pending.drain(), ["b", "c", "d"], "the oldest candidate is dropped, not the newest");
  assert.equal(pending.size, 0, "draining empties the queue");

  // --- Remote capability --------------------------------------------------
  assert.equal(supportsFederatedCalls(["federated-calls-v1", "federated-typing"]), true);
  assert.equal(
    supportsFederatedCalls(["federated-calls"]),
    false,
    "the unversioned flag is not evidence of compatibility",
  );
  assert.equal(supportsFederatedCalls(undefined), false);

  // --- TURN and iceTransportPolicy ----------------------------------------
  assert.equal(iceTransportPolicy("relay"), "relay");
  assert.equal(iceTransportPolicy("all"), "all");
  assert.equal(iceTransportPolicy(undefined), "all");
  const relayOnly = callRTCConfigurationFrom({
    ice_servers: [{ urls: ["turns:turn.example:5349"], username: "u", credential: "c" }],
    relay_policy: "relay",
  });
  assert.equal(relayOnly.iceTransportPolicy, "relay", "a relay policy must reach RTCPeerConnection");
  assert.deepEqual(relayOnly.iceServers, [{ urls: ["turns:turn.example:5349"], username: "u", credential: "c" }]);
  assert.equal(
    callRTCConfigurationFrom({ ice_servers: [] }).iceServers[0].urls,
    "stun:stun.l.google.com:19302",
    "an empty server list falls back to public STUN",
  );

  // --- app.js wiring ------------------------------------------------------
  assert.ok(
    !/state\.me\.id\s*[<>]\s*userID/.test(app),
    "app.js must not decide negotiation from numeric user identifiers",
  );
  assert.match(
    app,
    /const peer = new RTCPeerConnection\(await callRTCConfiguration\(\)\)/,
    "the peer connection must be built from the server configuration, including iceTransportPolicy",
  );
  assert.match(
    app,
    /const admission = callSignalLedger\.accept\(event\);\s*\n\s*if \(!admission\.ok\) return;/,
    "inbound call signals must pass the deduplication and expiry ledger",
  );
  assert.match(
    app,
    /await peerState\.link\.acceptDescription\(sdp\)/,
    "incoming offers must go through the shared perfect-negotiation link",
  );
  assert.match(
    app,
    /peerState\.link\?\.learnIdentities\(known, localCallIdentity\(\)\);/,
    "an identity learned after the peer was created must update the negotiation role",
  );
  assert.match(
    app,
    /supported: !isFederatedConversation\(conversation\),\s*\n\s*reason: "unverified",/,
    "a federated conversation must not be enabled when its capability could not be verified",
  );
  assert.match(
    app,
    /sequence: callSequencer\.next\(\{\s*\n\s*conversationID,\s*\n\s*sender: localCallIdentity\(\),\s*\n\s*callID,\s*\n\s*target: resolvedTarget,/,
    "outbound sequences must be scoped by conversation, sender, call and addressee",
  );
  assert.match(
    app,
    /if \(callNeedsCanonicalIdentity\(\) && !\(await ensureCallIdentity\(\)\)\)/,
    "starting a call that needs canonical identities must retry the configuration, then refuse without one",
  );
  assert.match(
    app,
    /if \(callNeedsCanonicalIdentity\(callConversation\(\)\) && !\(await ensureCallIdentity\(\)\)\)[\s\S]{0,400}reason: "identity_unavailable"/,
    "accepting a federated call must verify the identity and reject explicitly when it is missing",
  );
  assert.ok(
    app.indexOf("await ensureCallIdentity()") < app.indexOf("await ensureLocalCallStream();\n    state.call.status = \"accepted\""),
    "the identity must be verified before the microphone or camera is opened",
  );
  assert.match(
    app,
    /const stale = cached && !cached\.verified && Date\.now\(\) - cached\.loadedAt >= CALL_CONFIG_RETRY_MS;/,
    "a fallback call configuration must be retried rather than cached for the page's lifetime",
  );

  // --- A local private call must not depend on the canonical identity ------
  // Its offer direction is decided by the call itself, so a failed
  // /api/calls/config leaves purely local calling intact.
  assert.equal(shouldOfferAfterAccept({ direction: "outgoing" }), true);
  assert.match(
    app,
    /function callNeedsCanonicalIdentity\(conversation = state\.current\) \{\s*\n\s*return Boolean\(conversation\) && \(conversation\.type === "group" \|\| isFederatedConversation\(conversation\)\);/,
    "only group and federated conversations may require a canonical identity",
  );

  // --- The browser-side bookkeeping is bounded ----------------------------
  let boundedClock = Date.parse("2026-08-10T12:00:00.000Z");
  const bounded = createCallSignalLedger({ now: () => boundedClock, capacity: 32 });
  for (let index = 0; index < 500; index += 1) {
    bounded.accept({
      event_id: `flood-${index}`,
      conversation_id: index,
      call_id: `call-${index}`,
      sequence: 1,
      type: "call_offer",
      sender: alice,
      expires_at: new Date(boundedClock + 30_000).toISOString(),
    });
  }
  const sizes = bounded.sizes();
  for (const [name, size] of Object.entries(sizes)) {
    assert.ok(size <= 32, `the ledger's ${name} map grew to ${size} entries despite its cap`);
  }

  const boundedSequencer = createCallSequencer({ capacity: 16 });
  for (let index = 0; index < 200; index += 1) {
    boundedSequencer.next({ conversationID: index, sender: alice, callID: `call-${index}` });
  }
  assert.ok(boundedSequencer.size() <= 16, "the sequencer must stay bounded");
  assert.equal(
    boundedSequencer.next({ conversationID: 199, sender: alice, callID: "call-199" }),
    2,
    "the most recent call keeps its counter",
  );

  // Identifiers are client-chosen and may contain control characters. A
  // separator-based key made forgetting "call" also forget "call<sep>tail".
  // Length-prefixed tuple keys must keep those calls independent.
  const adversarialSequencer = createCallSequencer();
  const embeddedSeparatorCall = "call\u001ftail";
  const adversarialNext = (callID) => adversarialSequencer.next({
    conversationID: 1, sender: alice, callID,
  });
  assert.equal(adversarialNext(embeddedSeparatorCall), 1);
  assert.equal(adversarialNext(embeddedSeparatorCall), 2);
  adversarialSequencer.forget({ conversationID: 1, sender: alice, callID: "call" });
  assert.equal(
    adversarialNext(embeddedSeparatorCall),
    3,
    "teardown of a prefix call id must not erase an identifier containing the old separator",
  );

  // --- Local teardown must keep the tombstone ------------------------------
  //
  // clearCallState() used to call forget(), which erased the tombstone along
  // with the sequences — undoing the very protection the tombstone exists for.
  // A late invitation or offer carrying an unseen event id would then be
  // admitted into a call the user had already ended.
  {
    let teardownClock = Date.parse("2026-08-10T12:00:00.000Z");
    const ledger = createCallSignalLedger({ now: () => teardownClock });
    const scope = { conversationID: 4, sender: bob, callID: "call-teardown" };
    const signal = (id, type, sequence) => ({
      event_id: id, conversation_id: 4, call_id: "call-teardown", sequence, type, sender: bob,
      expires_at: new Date(teardownClock + 30_000).toISOString(),
    });

    // 1. A hangup arrives from the peer.
    assert.equal(ledger.accept(signal("t1", "call_hangup", 5)).ok, true);
    assert.equal(ledger.hasEnded(scope), true, "a hangup must record a tombstone");

    // 2. Local state is cleaned up, as clearCallState() does.
    ledger.endCall(scope);
    assert.equal(ledger.hasEnded(scope), true, "local teardown must not erase the tombstone");

    // 3. A late offer with a brand new event id — invisible to deduplication.
    assert.equal(
      ledger.accept(signal("never-seen-before", "call_offer", 6)).reason,
      "call_ended",
      "a late offer after teardown must be refused",
    );
    // A late invitation is refused for the same reason.
    assert.equal(ledger.accept(signal("also-new", "call_invite", 7)).reason, "call_ended");

    // A reject is terminal too, and ends a call the same way.
    const rejected = { conversationID: 4, sender: bob, callID: "call-rejected" };
    assert.equal(ledger.accept({
      event_id: "r1", conversation_id: 4, call_id: "call-rejected", sequence: 1,
      type: "call_reject", sender: bob,
      expires_at: new Date(teardownClock + 30_000).toISOString(),
    }).ok, true);
    ledger.endCall(rejected);
    assert.equal(ledger.hasEnded(rejected), true);

    // The tombstone expires on its own rather than lasting for ever.
    teardownClock += 120_001;
    assert.equal(ledger.hasEnded(scope), false, "a tombstone must expire");

    // Another conversation using the same call id is untouched throughout.
    const elsewhere = { conversationID: 5, sender: bob, callID: "call-teardown" };
    assert.equal(ledger.hasEnded(elsewhere), false, "a tombstone must not leak across conversations");
    assert.equal(ledger.accept({
      event_id: "other-conversation", conversation_id: 5, call_id: "call-teardown", sequence: 1,
      type: "call_offer", sender: bob,
      expires_at: new Date(teardownClock + 30_000).toISOString(),
    }).ok, true, "an identically named call elsewhere must still work");
  }

  // The same event id in two conversations is not a duplicate.
  {
    const clockValue = Date.parse("2026-08-10T12:00:00.000Z");
    const ledger = createCallSignalLedger({ now: () => clockValue });
    const shared = (conversationID) => ({
      event_id: "shared", conversation_id: conversationID, call_id: "c", sequence: 1,
      type: "call_offer", sender: alice,
      expires_at: new Date(clockValue + 30_000).toISOString(),
    });
    assert.equal(ledger.accept(shared(1)).ok, true);
    assert.equal(ledger.accept(shared(2)).ok, true, "the same event id must be accepted in another conversation");
    assert.equal(ledger.accept(shared(1)).reason, "duplicate", "within one conversation it is still a duplicate");
  }

  assert.match(
    app,
    /callSignalLedger\.endCall\(\{ conversationID: call\.conversationID, sender: identity, callID: call\.id \}\)/,
    "local teardown must keep the tombstone rather than forgetting the call",
  );
  assert.match(
    app,
    /elements\.callScreenShareButton\.hidden = !controlsVisible \|\| state\.call\.media !== "video"/,
    "screen sharing must only be offered during video calls",
  );

  console.log("call negotiation tests passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
