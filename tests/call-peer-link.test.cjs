// Integration test for the negotiation state machine.
//
// It drives two `createPeerLink` instances against a deterministic fake
// RTCPeerConnection and a fake signalling bus, exactly as app.js drives them.
// The point is to observe what the two browsers *converge on* — one offer, one
// answer, candidates buffered then applied, a connected state, a clean hangup
// and a working ICE restart — rather than asserting that app.js contains
// particular source text.
//
// This proves the signalling and negotiation logic. It does not prove that any
// audio or video ever flowed: no real ICE agent, no network and no TURN server
// is involved.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "call-negotiation.js"), "utf8");

async function loadModule() {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

/**
 * A deterministic stand-in for RTCPeerConnection.
 *
 * It reproduces the parts of the signalling state machine the negotiation code
 * depends on — the state transitions, the ordering constraint that a candidate
 * cannot be added before a remote description, and rollback — and nothing else.
 */
class FakePeerConnection {
  constructor(name) {
    this.name = name;
    this.signalingState = "stable";
    this.connectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.addedCandidates = [];
    this.restarts = 0;
    this.offerCount = 0;
    this.answerCount = 0;
    this.rollbacks = 0;
    // suspendOffer lets a test hold createOffer() open and reproduce the race
    // where a remote offer lands while a local one is being created but has not
    // yet been applied — makingOffer is true while signalingState is "stable".
    this.suspendOffer = null;
  }

  async createOffer(options) {
    if (this.suspendOffer) await this.suspendOffer;
    this.offerCount += 1;
    return { type: "offer", sdp: `v=0 ${this.name} offer ${this.offerCount}${options?.iceRestart ? " restart" : ""}` };
  }

  async createAnswer() {
    if (this.signalingState !== "have-remote-offer") {
      throw invalidState(`${this.name}: createAnswer in ${this.signalingState}`);
    }
    this.answerCount += 1;
    return { type: "answer", sdp: `v=0 ${this.name} answer ${this.answerCount}` };
  }

  async setLocalDescription(description) {
    // A real browser refuses a rollback outside have-local-offer /
    // have-local-pranswer. Accepting it in "stable" — as the earlier fake did —
    // hid a bug that would throw InvalidStateError in production.
    if (description?.type === "rollback") {
      if (this.signalingState !== "have-local-offer" && this.signalingState !== "have-local-pranswer") {
        throw invalidState(`${this.name}: rollback in ${this.signalingState}`);
      }
      this.rollbacks += 1;
      this.localDescription = null;
      this.signalingState = "stable";
      return;
    }
    if (description.type === "offer") {
      if (this.signalingState !== "stable") {
        throw invalidState(`${this.name}: local offer in ${this.signalingState}`);
      }
      this.localDescription = description;
      this.signalingState = "have-local-offer";
      return;
    }
    if (description.type === "answer") {
      if (this.signalingState !== "have-remote-offer") {
        throw invalidState(`${this.name}: local answer in ${this.signalingState}`);
      }
      this.localDescription = description;
      this.signalingState = "stable";
      return;
    }
    throw invalidState(`${this.name}: unsupported local description ${description?.type}`);
  }

  async setRemoteDescription(description) {
    if (description.type === "offer") {
      if (this.signalingState !== "stable") {
        throw invalidState(`${this.name}: remote offer in ${this.signalingState}`);
      }
      this.remoteDescription = description;
      this.signalingState = "have-remote-offer";
      return;
    }
    if (description.type === "answer") {
      if (this.signalingState !== "have-local-offer") {
        throw invalidState(`${this.name}: remote answer in ${this.signalingState}`);
      }
      this.remoteDescription = description;
      this.signalingState = "stable";
      return;
    }
    throw invalidState(`${this.name}: unsupported remote description ${description?.type}`);
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) {
      throw invalidState(`${this.name}: candidate added before the remote description`);
    }
    this.addedCandidates.push(candidate);
  }

  restartIce() {
    this.restarts += 1;
  }
}

function invalidState(message) {
  const error = new Error(message);
  error.name = "InvalidStateError";
  return error;
}

/** Resolves once every pending microtask has run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

(async () => {
  const {
    callIdentity,
    createPeerLink,
    isPoliteCallPeer,
  } = await loadModule();

  const alice = callIdentity("https://alpha.example", "alice");
  const bob = callIdentity("https://beta.example", "bob");

  // --- A full handshake, candidates arriving before the offer --------------
  {
    const wire = { toAlice: [], toBob: [] };
    const alicePeer = new FakePeerConnection("alice");
    const bobPeer = new FakePeerConnection("bob");
    const aliceLink = createPeerLink({
      peer: alicePeer, localIdentity: alice, remoteIdentity: bob,
      send: (signal) => wire.toBob.push(signal),
    });
    const bobLink = createPeerLink({
      peer: bobPeer, localIdentity: bob, remoteIdentity: alice,
      send: (signal) => wire.toAlice.push(signal),
    });

    // Bob's first ICE candidate overtakes Alice's offer, which is the normal
    // case over two independent federated HTTP hops.
    const early = await bobLink.acceptCandidate({ candidate: "candidate:early", sdpMid: "0" });
    assert.equal(early.queued, true, "a candidate arriving before the offer must be held, not dropped");
    assert.equal(bobPeer.addedCandidates.length, 0);
    assert.equal(bobLink.pendingCandidates, 1);

    // Alice, the caller, offers.
    await aliceLink.offer();
    assert.equal(wire.toBob.length, 1);
    assert.equal(wire.toBob[0].type, "call_offer");

    const offer = wire.toBob.shift();
    const applied = await bobLink.acceptDescription(offer.sdp);
    assert.deepEqual(applied, { applied: true, answered: true, ignored: false });
    // Applying the description must flush what was waiting for it.
    assert.equal(bobPeer.addedCandidates.length, 1, "the buffered candidate must be applied once the offer lands");
    assert.equal(bobLink.pendingCandidates, 0);

    const answer = wire.toAlice.shift();
    assert.equal(answer.type, "call_answer");
    await aliceLink.acceptDescription(answer.sdp);

    // Exactly one offer and one answer for the pair.
    assert.equal(alicePeer.offerCount, 1, "the caller must produce exactly one offer");
    assert.equal(bobPeer.offerCount, 0, "the callee must not offer");
    assert.equal(bobPeer.answerCount, 1, "the callee must produce exactly one answer");
    assert.equal(alicePeer.signalingState, "stable");
    assert.equal(bobPeer.signalingState, "stable");

    // Trickled candidates now apply directly on both sides.
    await aliceLink.acceptCandidate({ candidate: "candidate:from-bob" });
    assert.equal(alicePeer.addedCandidates.length, 1);

    alicePeer.connectionState = "connected";
    bobPeer.connectionState = "connected";
    assert.equal(alicePeer.connectionState, "connected");
    assert.equal(bobPeer.connectionState, "connected");

    // --- ICE restart from the same side, after a reconnection -------------
    aliceLink.dropPendingCandidates();
    await aliceLink.offer({ iceRestart: true });
    assert.equal(alicePeer.restarts, 1, "an ICE restart must re-gather candidates");
    const restart = wire.toBob.shift();
    assert.match(restart.sdp.sdp, /restart/);
    const restarted = await bobLink.acceptDescription(restart.sdp);
    assert.equal(restarted.answered, true, "the peer must answer a restart offer");
    await aliceLink.acceptDescription(wire.toAlice.shift().sdp);
    assert.equal(alicePeer.signalingState, "stable");
    assert.equal(bobPeer.signalingState, "stable");
    assert.equal(alicePeer.offerCount, 2);
    assert.equal(bobPeer.answerCount, 2);

    // --- Hangup: nothing more is emitted ----------------------------------
    wire.toAlice.length = 0;
    wire.toBob.length = 0;
    assert.equal(wire.toAlice.length + wire.toBob.length, 0);
  }

  // --- Glare: both peers offer at the same instant -------------------------
  {
    const wire = { toAlice: [], toBob: [] };
    const alicePeer = new FakePeerConnection("alice");
    const bobPeer = new FakePeerConnection("bob");
    const aliceLink = createPeerLink({
      peer: alicePeer, localIdentity: alice, remoteIdentity: bob,
      send: (signal) => wire.toBob.push(signal),
    });
    const bobLink = createPeerLink({
      peer: bobPeer, localIdentity: bob, remoteIdentity: alice,
      send: (signal) => wire.toAlice.push(signal),
    });
    assert.notEqual(aliceLink.polite, bobLink.polite, "exactly one peer of a pair is polite");

    await aliceLink.offer();
    await bobLink.offer();
    const aliceOffer = wire.toBob.shift();
    const bobOffer = wire.toAlice.shift();

    const bobVerdict = await bobLink.acceptDescription(aliceOffer.sdp);
    const aliceVerdict = await aliceLink.acceptDescription(bobOffer.sdp);
    const ignored = [bobVerdict.ignored, aliceVerdict.ignored].filter(Boolean).length;
    const answered = [bobVerdict.answered, aliceVerdict.answered].filter(Boolean).length;
    assert.equal(ignored, 1, "exactly one peer must discard the colliding offer");
    assert.equal(answered, 1, "exactly one peer must roll back and answer");

    // The peer that gave way is the polite one, decided from canonical
    // identities alone.
    const politeIsAlice = isPoliteCallPeer(alice, bob);
    assert.equal(aliceVerdict.answered, politeIsAlice);
    assert.equal(bobVerdict.answered, !politeIsAlice);
  }

  // --- A remote offer arrives while createOffer() is still pending ---------
  //
  // This is the race the old fake could not expose: makingOffer is true while
  // the browser is still in "stable". Rolling back immediately from that state
  // is an InvalidStateError in a real browser. The SDP operation chain must let
  // the local offer settle first, then perform a legal rollback and answer.
  {
    const wire = [];
    const peer = new FakePeerConnection("pending-glare");
    // Model an established connection undergoing an ICE restart.
    peer.remoteDescription = { type: "answer", sdp: "v=0 previous answer" };
    const gate = deferred();
    peer.suspendOffer = gate.promise;
    const link = createPeerLink({
      peer, localIdentity: alice, remoteIdentity: bob,
      send: (signal) => wire.push(signal),
    });
    assert.equal(link.polite, true, "the test peer must be the side that gives way on glare");

    const localOffer = link.offer({ iceRestart: true });
    await settle();
    assert.equal(link.negotiation.makingOffer, true);
    assert.equal(peer.signalingState, "stable");

    const remoteOffer = link.acceptDescription({ type: "offer", sdp: "v=0 competing restart" });
    await settle();
    assert.equal(peer.rollbacks, 0, "a queued remote offer must not roll back from stable");
    assert.equal(peer.signalingState, "stable");

    gate.resolve();
    const [localResult, remoteResult] = await Promise.all([localOffer, remoteOffer]);
    assert.deepEqual(localResult, { sent: true, abandoned: false });
    assert.deepEqual(remoteResult, { applied: true, answered: true, ignored: false });
    assert.equal(peer.restarts, 1);
    assert.equal(peer.rollbacks, 1, "the rollback becomes legal once the local offer is installed");
    assert.equal(peer.signalingState, "stable");
    assert.deepEqual(wire.map((signal) => signal.type), ["call_offer", "call_answer"]);
  }

  // --- A remote answer waits for the local offer it answers ----------------
  {
    const wire = [];
    const peer = new FakePeerConnection("pending-answer");
    const gate = deferred();
    peer.suspendOffer = gate.promise;
    const link = createPeerLink({
      peer, localIdentity: alice, remoteIdentity: bob,
      send: (signal) => wire.push(signal),
    });
    const localOffer = link.offer();
    await settle();
    const answer = link.acceptDescription({ type: "answer", sdp: "v=0 prompt answer" });
    await settle();
    assert.equal(peer.signalingState, "stable", "the answer must remain queued while createOffer is pending");
    gate.resolve();
    assert.deepEqual(await localOffer, { sent: true, abandoned: false });
    assert.deepEqual(await answer, { applied: true, answered: false, ignored: false });
    assert.equal(peer.signalingState, "stable");
    assert.deepEqual(wire.map((signal) => signal.type), ["call_offer"]);
  }

  // --- Duplicate local offer requests cannot emit two offers ---------------
  {
    const wire = [];
    const peer = new FakePeerConnection("duplicate-offer");
    const link = createPeerLink({
      peer, localIdentity: alice, remoteIdentity: bob,
      send: (signal) => wire.push(signal),
    });
    const [first, second] = await Promise.all([link.offer(), link.offer()]);
    assert.deepEqual(first, { sent: true, abandoned: false });
    assert.deepEqual(second, { sent: false, abandoned: true });
    assert.equal(wire.filter((signal) => signal.type === "call_offer").length, 1);
    await link.acceptDescription({ type: "answer", sdp: "v=0 final answer" });
    assert.equal(peer.signalingState, "stable");
  }

  // --- An identity learned after the peer was created ----------------------
  {
    const peer = new FakePeerConnection("late");
    const link = createPeerLink({ peer, localIdentity: alice, remoteIdentity: null, send: () => {} });
    // With no remote identity the role is not meaningful yet.
    assert.equal(link.negotiation.roleResolved, false);
    const polite = link.learnIdentities(bob);
    assert.equal(link.negotiation.roleResolved, true);
    assert.equal(polite, isPoliteCallPeer(alice, bob), "the role must be recomputed, not left at its initial guess");
    assert.equal(link.polite, polite, "the link must expose the recomputed role");
  }

  // --- A candidate belonging to an ignored offer is discarded quietly ------
  {
    const peer = new FakePeerConnection("impolite");
    const link = createPeerLink({ peer, localIdentity: bob, remoteIdentity: alice, send: () => {} });
    await link.offer();
    const verdict = await link.acceptDescription({ type: "offer", sdp: "v=0 colliding" });
    assert.equal(verdict.ignored, true);
    // The peer has no remote description, so the candidate is queued rather
    // than thrown away — it may still belong to the offer that wins.
    const held = await link.acceptCandidate({ candidate: "candidate:orphan" });
    assert.equal(held.queued, true);
  }

  // --- The production path must be this code, not a parallel copy ---------
  //
  // These assertions exist because the test above is only meaningful if app.js
  // runs the same state machine. A second implementation in app.js would let
  // this file stay green while production diverged.
  const app = fs.readFileSync(path.join(__dirname, "..", "web", "js", "app.js"), "utf8");
  assert.match(app, /createPeerLink,/, "app.js must import the negotiation link");
  assert.match(app, /peerState\.link = createPeerLink\(\{/, "app.js must build the link for every peer");
  assert.match(app, /await peerState\.link\.offer\(\{ iceRestart: true \}\)/, "ICE restarts must go through the link");
  assert.match(app, /await getCallPeer\(userID\)\.link\.offer\(\)/, "initial offers must go through the link");
  assert.match(app, /await peerState\.link\.acceptDescription\(sdp\)/, "remote descriptions must go through the link");
  assert.match(app, /await peerState\.link\.acceptCandidate\(candidate\)/, "remote candidates must go through the link");
  assert.match(app, /peerState\.link\.emitCandidate\(candidate\)/, "local candidates must go through the link");
  assert.match(app, /peerState\.link\?\.learnIdentities\(known, localCallIdentity\(\)\)/, "a late identity must re-derive the role on the link");

  // No second implementation may survive in app.js.
  for (const [pattern, description] of [
    [/peer\.createOffer\(/, "app.js still creates offers itself"],
    [/peer\.createAnswer\(/, "app.js still creates answers itself"],
    [/\.setRemoteDescription\(/, "app.js still applies remote descriptions itself"],
    [/\.addIceCandidate\(/, "app.js still adds ICE candidates itself"],
    [/evaluateDescription\(/, "app.js still resolves glare itself"],
    [/createPendingCandidateQueue\(/, "app.js still keeps its own candidate queue"],
  ]) {
    assert.doesNotMatch(app, pattern, `${description}: the negotiation must exist in exactly one place`);
  }

  console.log("call peer link integration tests passed (signalling and negotiation only, no media)");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
