// Federated call negotiation logic, kept separate from app.js so it can be
// unit tested without a browser, a socket or a peer connection.
//
// Everything here is a pure function of its inputs. The rule that matters most:
// no decision is ever made from a numeric user id. Those ids are allocated by
// each instance's own database, so two browsers on two servers disagree about
// them — the same person has different ids on each side, and two different
// people routinely share one. Comparing them to pick who sends the offer makes
// both peers offer, or neither.

export const CALL_PROTOCOL_VERSION = "federated-calls-v1";

// How long a signal stays meaningful. Matches the server's default TTL.
export const CALL_EVENT_TTL_MS = 30_000;

// Clock skew tolerated when judging another instance's timestamps.
export const CALL_CLOCK_SKEW_MS = 30_000;

// How long an ended call stays refusable, so a signal still in flight when the
// user hung up cannot reopen a session that no longer exists.
export const CALL_TOMBSTONE_TTL_MS = 120_000;

// Hard ceilings on the browser-side bookkeeping. A single call uses a handful
// of entries; these are sized for a busy session, not for a flood.
export const CALL_LEDGER_CAPACITY = 2048;
export const CALL_SEQUENCER_CAPACITY = 512;

/** Canonicalizes an instance base URL: scheme and host lowercased, default port
 * and trailing slashes removed. */
export function normalizeCallInstance(instance) {
  const value = String(instance ?? "").trim();
  if (!value) return "local";
  if (!value.includes("://")) return value.toLowerCase().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value.toLowerCase().replace(/\/+$/, "");
  }
  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  const defaultPort = (scheme === "https" && parsed.port === "443") || (scheme === "http" && parsed.port === "80");
  const host = defaultPort ? parsed.hostname.toLowerCase() : parsed.host.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${scheme}://${host}${path}`;
}

/** Builds the canonical, cross-instance identity of a call participant. */
export function callIdentity(instance, username) {
  return {
    instance: normalizeCallInstance(instance),
    username: String(username ?? "").trim().toLowerCase(),
  };
}

/** The wire and comparison form of an identity. */
export function canonicalCallIdentity(identity) {
  if (!identity?.instance || !identity?.username) return "";
  return `${identity.instance}|${identity.username}`;
}

/** Reads a canonical identity string back into its parts. */
export function parseCallIdentity(value) {
  const raw = String(value ?? "");
  const separator = raw.indexOf("|");
  if (separator <= 0) return null;
  const identity = callIdentity(raw.slice(0, separator), raw.slice(separator + 1));
  return identity.username ? identity : null;
}

export function sameCallIdentity(left, right) {
  const canonical = canonicalCallIdentity(left);
  return Boolean(canonical) && canonical === canonicalCallIdentity(right);
}

/**
 * Decides which side of a pair plays the polite role of WebRTC "perfect
 * negotiation". Both browsers run this on the same two canonical identities and
 * necessarily reach opposite answers, without exchanging anything.
 */
export function isPoliteCallPeer(localIdentity, remoteIdentity) {
  const local = canonicalCallIdentity(localIdentity);
  const remote = canonicalCallIdentity(remoteIdentity);
  if (!local || !remote) return false;
  return local < remote;
}

/**
 * Decides who sends the first offer in a private call.
 *
 * The caller offers once the callee accepts; the callee waits. This follows the
 * call itself rather than any identity comparison, so the offer always travels
 * in the direction the media negotiation is already going, and A→B and B→A
 * behave identically.
 */
export function shouldOfferAfterAccept(call) {
  return call?.direction === "outgoing";
}

/**
 * Decides who re-offers in a group call, where several peers accept
 * independently and there is no single "caller" per pair. The impolite peer
 * offers, so a simultaneous accept produces one offer rather than a collision.
 */
export function shouldOfferInGroup(localIdentity, remoteIdentity) {
  return !isPoliteCallPeer(localIdentity, remoteIdentity);
}

/**
 * Perfect negotiation state for one peer connection.
 *
 * The three flags are the ones the WebRTC specification requires to survive a
 * glare: makingOffer (a local offer is being created and applied),
 * ignoreOffer (a colliding remote offer this peer is entitled to discard) and
 * isSettingRemoteAnswerPending (an answer is in flight, during which the
 * signalling state is momentarily not "stable" but the peer is still ready).
 */
export class PeerNegotiation {
  constructor(localIdentity, remoteIdentity) {
    this.localIdentity = localIdentity || null;
    this.remoteIdentity = remoteIdentity || null;
    this.polite = isPoliteCallPeer(this.localIdentity, this.remoteIdentity);
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
  }

  /**
   * Adopts an identity learned after construction and recomputes the role.
   *
   * A peer is often created before its canonical identity is known — the first
   * signal from that participant is what reveals it. Storing the identity
   * without recomputing `polite` would leave the negotiation running on the
   * role it guessed with no identity at all, and two peers can easily guess the
   * same one, which is exactly the collision this class exists to prevent.
   */
  setIdentities(localIdentity, remoteIdentity) {
    if (localIdentity) this.localIdentity = localIdentity;
    if (remoteIdentity) this.remoteIdentity = remoteIdentity;
    this.polite = isPoliteCallPeer(this.localIdentity, this.remoteIdentity);
    return this.polite;
  }

  /** Whether both canonical identities are known, so the role is trustworthy. */
  get roleResolved() {
    return Boolean(canonicalCallIdentity(this.localIdentity) && canonicalCallIdentity(this.remoteIdentity));
  }

  beginOffer() {
    this.makingOffer = true;
  }

  endOffer() {
    this.makingOffer = false;
  }

  /**
   * Classifies an incoming description against the current signalling state.
   *
   * Returns `ignore` when an impolite peer may drop a colliding offer, and
   * `rollback` when a polite peer must abandon its own in-flight offer before
   * accepting the remote one.
   */
  evaluateDescription(description, signalingState) {
    const type = description?.type;
    const readyForOffer = !this.makingOffer && (signalingState === "stable" || this.isSettingRemoteAnswerPending);
    const collision = type === "offer" && !readyForOffer;
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return { ignore: true, rollback: false };
    return { ignore: false, rollback: Boolean(this.polite && collision) };
  }

  beginRemoteAnswer() {
    this.isSettingRemoteAnswerPending = true;
  }

  endRemoteAnswer() {
    this.isSettingRemoteAnswerPending = false;
  }

  /** Whether a candidate arriving now may be discarded rather than reported. */
  mayDropCandidate() {
    return this.ignoreOffer;
  }

  reset() {
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
  }
}

/** Generates a call event identifier. */
export function newCallEventID() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The sequence scope of a broadcast, as opposed to an addressed signal. */
export const BROADCAST_TARGET = "*";

// Keys are built from client-chosen values (call ids and event ids). A simple
// separator is unsafe because the protocol deliberately accepts arbitrary
// strings up to a size limit: a crafted call id containing that separator can
// otherwise make teardown of one call erase another call's sequence state.
// Length-prefixing every component makes the tuple unambiguous without relying
// on a forbidden character that the wire format does not actually forbid.
function scopeKey(...parts) {
  return parts.map((part) => {
    const value = String(part ?? "");
    return `${value.length}:${value}`;
  }).join("");
}

/**
 * Builds the scope a sequence number is counted in.
 *
 * A sequence is per conversation, per sender, per call *and per addressee*.
 * Counting per call alone means a signal sent to one participant bumps the
 * counter that a signal to another participant is judged against, so in a group
 * the second peer's offer looks stale and is dropped — the peer then waits
 * forever for media. The conversation is in the key because the same call id
 * routinely appears in two unrelated conversations.
 */
export function callSequenceScope(conversationID, sender, callID, target) {
  return scopeKey(conversationID, canonicalCallIdentity(sender), callID,
    canonicalCallIdentity(target) || BROADCAST_TARGET);
}

/** The scope of one call, used for tombstones and for forgetting sequences. */
export function callScope(conversationID, sender, callID) {
  return scopeKey(conversationID, canonicalCallIdentity(sender), callID);
}

/**
 * Per-conversation, per-call, per-participant sequence counter. It lets a
 * receiver recognise an offer that is older than one it already applied, which
 * is the signal that a retransmission arrived after the handshake moved on.
 */
export function createCallSequencer({ capacity = CALL_SEQUENCER_CAPACITY } = {}) {
  const counters = new Map();
  return {
    next({ conversationID, sender, callID, target }) {
      const key = callSequenceScope(conversationID, sender, callID, target);
      const value = (counters.get(key) ?? 0) + 1;
      counters.set(key, value);
      // Bounded: an ended call's counters are dropped by forget(), but a client
      // that never tidies up must still not grow this map for ever.
      if (counters.size > capacity) {
        for (const stale of counters.keys()) {
          if (counters.size <= capacity) break;
          if (stale !== key) counters.delete(stale);
        }
      }
      return value;
    },
    forget({ conversationID, sender, callID }) {
      const prefix = callScope(conversationID, sender, callID);
      for (const key of counters.keys()) {
        if (key.startsWith(prefix)) counters.delete(key);
      }
    },
    size() {
      return counters.size;
    },
  };
}

/**
 * Deduplicates and expires inbound call signals.
 *
 * A duplicate is not an error — a retried federated hop is expected to produce
 * one — but applying an offer twice tears down a working connection, so it must
 * be dropped before it reaches the peer connection.
 */
export function createCallSignalLedger({
  now = () => Date.now(),
  skewMs = CALL_CLOCK_SKEW_MS,
  tombstoneMs = CALL_TOMBSTONE_TTL_MS,
  capacity = CALL_LEDGER_CAPACITY,
} = {}) {
  const seen = new Map();
  const sequences = new Map();
  const ended = new Map();

  // Maps are bounded as well as swept. A peer that floods distinct event ids
  // faster than they expire would otherwise grow these without limit; dropping
  // the oldest entries degrades deduplication for one window instead, which is
  // the lesser failure for a live signal.
  function trim(map, max) {
    if (map.size <= max) return;
    const excess = map.size - max;
    let dropped = 0;
    for (const key of map.keys()) {
      map.delete(key);
      if (++dropped >= excess) break;
    }
  }

  function sweep(currentTime) {
    for (const [id, expiresAt] of seen) {
      if (currentTime > expiresAt) seen.delete(id);
    }
    for (const [key, endsAt] of ended) {
      if (currentTime > endsAt) ended.delete(key);
    }
    trim(seen, capacity);
    trim(sequences, capacity);
    trim(ended, capacity);
  }

  const terminal = (type) => type === "call_hangup" || type === "call_reject";

  return {
    accept(event) {
      const currentTime = now();
      sweep(currentTime);
      const expiresAt = Date.parse(event?.expires_at ?? "");
      if (!Number.isFinite(expiresAt)) return { ok: false, reason: "invalid_expiry" };
      if (currentTime > expiresAt + skewMs) return { ok: false, reason: "expired" };
      const eventID = String(event?.event_id ?? "");
      if (!eventID) return { ok: false, reason: "missing_event_id" };
      const conversationID = event?.conversation_id ?? "";
      const sender = event?.sender;
      const callID = event?.call_id ?? "";
      // The event id is chosen by the client, so it is scoped like every other
      // key: two conversations, or two senders, may legitimately use the same
      // one and neither may silence the other.
      const seenKey = scopeKey(conversationID, canonicalCallIdentity(sender), eventID);
      if (seen.has(seenKey)) return { ok: false, reason: "duplicate" };
      const callKey = callScope(conversationID, sender, callID);
      // A call that ended stays ended. Deduplication cannot catch a late offer
      // carrying a fresh event id, so the tombstone is the only thing stopping
      // it from being applied to a session that no longer exists.
      if (!terminal(event?.type) && ended.has(callKey)) return { ok: false, reason: "call_ended" };
      const key = callSequenceScope(conversationID, sender, callID, event?.target);
      const sequence = Number(event?.sequence ?? 0);
      // ICE candidates are exempt: they describe independent network paths and
      // the browser accepts them in any order, so dropping a late one would
      // discard a usable route.
      if (event?.type !== "ice_candidate") {
        const last = sequences.get(key);
        if (last !== undefined && sequence > 0 && sequence < last) return { ok: false, reason: "stale" };
        if (!(last >= sequence)) sequences.set(key, sequence);
      }
      if (terminal(event?.type)) ended.set(callKey, currentTime + tombstoneMs);
      seen.set(seenKey, expiresAt + skewMs);
      // Trimmed after insertion as well as before, so the ceiling holds at every
      // observable point rather than only between calls.
      trim(seen, capacity);
      trim(sequences, capacity);
      trim(ended, capacity);
      return { ok: true, reason: "" };
    },

    /**
     * Drops the ordering state of a finished call while *keeping* its tombstone.
     *
     * This is what local teardown calls. Removing the tombstone at the same time
     * would undo the very protection it exists for: an invitation or offer for
     * that call, carrying an event id never seen before, would be admitted into
     * a session the user already ended.
     */
    endCall({ conversationID, sender, callID }) {
      const prefix = callScope(conversationID, sender, callID);
      for (const key of sequences.keys()) {
        if (key.startsWith(prefix)) sequences.delete(key);
      }
      ended.set(callScope(conversationID, sender, callID), now() + tombstoneMs);
      trim(ended, capacity);
    },

    /**
     * Erases every trace of a call, tombstone included.
     *
     * Only for cases where nothing about the call should be refused afterwards —
     * a call that never started, for instance. Local teardown must use endCall.
     */
    forget({ conversationID, sender, callID }) {
      const scope = callScope(conversationID, sender, callID);
      const prefix = scope;
      for (const key of sequences.keys()) {
        if (key.startsWith(prefix)) sequences.delete(key);
      }
      ended.delete(scope);
    },

    /** Whether this call is recorded as ended. */
    hasEnded({ conversationID, sender, callID }) {
      const endsAt = ended.get(callScope(conversationID, sender, callID));
      return endsAt !== undefined && now() <= endsAt;
    },

    size() {
      return seen.size;
    },
    sizes() {
      return { seen: seen.size, sequences: sequences.size, ended: ended.size };
    },
  };
}

/**
 * Bounded holding area for ICE candidates that arrive before the description
 * they belong to. The bound matters: without it a peer that never sends an
 * offer can make the caller accumulate candidates for the whole call.
 */
export function createPendingCandidateQueue(limit = 64) {
  const candidates = [];
  return {
    push(candidate) {
      if (candidates.length >= limit) {
        candidates.shift();
      }
      candidates.push(candidate);
      return candidates.length;
    },
    drain() {
      return candidates.splice(0, candidates.length);
    },
    get size() {
      return candidates.length;
    },
  };
}

/** Whether an instance's advertised features include the versioned protocol. */
export function supportsFederatedCalls(features) {
  return Array.isArray(features) && features.includes(CALL_PROTOCOL_VERSION);
}

/**
 * Maps the server's relay policy onto RTCConfiguration.iceTransportPolicy.
 *
 * "relay" is what makes a TURN deployment testable: the call either goes
 * through the relay or fails, instead of quietly succeeding over a direct path
 * that hides a broken TURN server until a symmetric NAT hits it.
 */
export function iceTransportPolicy(relayPolicy) {
  return String(relayPolicy ?? "").trim().toLowerCase() === "relay" ? "relay" : "all";
}

/** Builds the RTCConfiguration from the server's call configuration. */
export function callRTCConfigurationFrom(config) {
  const iceServers = Array.isArray(config?.ice_servers) && config.ice_servers.length
    ? config.ice_servers
    : [{ urls: "stun:stun.l.google.com:19302" }];
  return { iceServers, iceTransportPolicy: iceTransportPolicy(config?.relay_policy) };
}

/** Human-readable explanation for a delivery failure reported by the server. */
export function callFailureMessage(reason) {
  switch (reason) {
    case "recipient_offline":
      return "Le correspondant n’est pas connecté.";
    case "queue_full":
      return "Le correspondant ne peut plus recevoir la signalisation d’appel.";
    case "unknown_target":
      return "Le correspondant est introuvable sur son instance.";
    case "instance_inactive":
      return "L’instance du correspondant est désactivée.";
    case "transport_error":
      return "L’instance du correspondant est injoignable.";
    case "unsupported_protocol":
      return "L’instance du correspondant ne prend pas en charge les appels fédérés.";
    case "expired":
      return "La signalisation d’appel a expiré avant d’être remise.";
    case "rate_limited":
      return "Trop de tentatives d’appel. Patientez quelques instants.";
    default:
      return "La signalisation d’appel n’a pas pu être remise.";
  }
}

/** Explains, in the call button tooltip, why calls are unavailable. */
export function callCapabilityMessage(reason) {
  switch (reason) {
    case "unsupported_protocol":
      return "L’instance du correspondant ne prend pas en charge les appels fédérés (federated-calls-v1).";
    case "instance_inactive":
      return "L’instance du correspondant est désactivée.";
    case "unverified":
      return "Compatibilité de l’instance du correspondant non vérifiée. Nouvelle tentative dans quelques secondes.";
    case "no_local_identity":
      return "Identité d’appel indisponible : la configuration des appels n’a pas pu être chargée.";
    default:
      return "Les appels ne sont pas disponibles pour cette conversation.";
  }
}

/**
 * Drives one RTCPeerConnection through the negotiation protocol.
 *
 * This is the part of a call that is pure state machine: create an offer, react
 * to a description, buffer candidates that arrive early, restart ICE. It is
 * separated from app.js so it can be exercised end to end against a fake
 * RTCPeerConnection — a test that only inspects app.js source text proves that
 * the code was written, not that two browsers converge on one offer and one
 * answer.
 *
 * Media, UI and transport stay in app.js: this object never touches the DOM and
 * never decides *whether* to call, only how to negotiate once told to.
 */
export function createPeerLink({ peer, localIdentity, remoteIdentity, send, pendingLimit = 64 }) {
  const negotiation = new PeerNegotiation(localIdentity, remoteIdentity);
  const pending = createPendingCandidateQueue(pendingLimit);

  // Every SDP operation runs on one chain.
  //
  // This is what makes glare survivable. createOffer() is asynchronous, so a
  // remote offer can arrive while a local one is being created but has not been
  // applied yet: makingOffer is true while signalingState is still "stable". A
  // peer that reacted immediately would either roll back from "stable" — which
  // a real browser refuses with InvalidStateError — or, worse, apply its own
  // half-built offer *after* answering the remote one, clobbering a completed
  // negotiation. Serializing means the remote offer waits for the local one to
  // settle, and the collision is then resolved from a state the specification
  // actually allows.
  let operations = Promise.resolve();
  function serialize(task) {
    const result = operations.then(task, task);
    // The chain must survive a failed operation, or one error would wedge every
    // later negotiation on this peer.
    operations = result.then(() => {}, () => {});
    return result;
  }

  // generation invalidates an offer that lost a race while it was being built.
  let generation = 0;

  async function drainPendingCandidates() {
    if (!peer.remoteDescription) return;
    for (const candidate of pending.drain()) {
      try {
        await peer.addIceCandidate(candidate);
      } catch (error) {
        // A candidate belonging to an offer this peer ignored is expected to
        // fail; anything else is worth surfacing to the caller's logger.
        if (!negotiation.mayDropCandidate()) throw error;
      }
    }
  }

  return {
    negotiation,
    get polite() {
      return negotiation.polite;
    },
    get pendingCandidates() {
      return pending.size;
    },

    /** Adopts identities learned after the link was created and re-derives the
     * polite/impolite role. Both halves are accepted because the local
     * canonical identity can also arrive late — it comes from the call
     * configuration, which may have failed on the first attempt. */
    learnIdentities(remote, local) {
      if (local) localIdentity = local;
      return negotiation.setIdentities(localIdentity, remote);
    },

    /**
     * Creates and sends an offer. `iceRestart` re-gathers candidates.
     *
     * Returns whether the offer actually went out: one built while a remote
     * offer won the race is abandoned rather than applied late.
     */
    offer({ iceRestart = false } = {}) {
      return serialize(async () => {
        const mine = ++generation;
        negotiation.beginOffer();
        try {
          if (iceRestart) peer.restartIce?.();
          const description = await peer.createOffer(iceRestart ? { iceRestart: true } : undefined);
          // Someone else's offer was applied while this one was being built, or
          // a newer local offer superseded it. Applying it now would undo a
          // negotiation that has already moved on.
          if (mine !== generation || peer.signalingState !== "stable") {
            return { sent: false, abandoned: true };
          }
          await peer.setLocalDescription(description);
          send({ type: "call_offer", sdp: describe(peer.localDescription) });
          return { sent: true, abandoned: false };
        } finally {
          negotiation.endOffer();
        }
      });
    },

    /**
     * Applies a remote description, answering when it was an offer.
     *
     * Returns what happened, so the caller can distinguish "we ignored a
     * colliding offer" from "we answered" without re-deriving the rule.
     */
    acceptDescription(description) {
      return serialize(async () => {
        if (description?.type === "answer" || description?.type === "pranswer") {
          if (peer.signalingState !== "have-local-offer") {
            // The offer this answers was rolled back or abandoned; applying it
            // would throw. Dropping it is correct: the negotiation it belonged
            // to no longer exists.
            return { applied: false, answered: false, ignored: true };
          }
          negotiation.beginRemoteAnswer();
          try {
            await peer.setRemoteDescription(description);
          } finally {
            negotiation.endRemoteAnswer();
          }
          await drainPendingCandidates();
          return { applied: true, answered: false, ignored: false };
        }
        const { ignore, rollback } = negotiation.evaluateDescription(description, peer.signalingState);
        if (ignore) {
          // The impolite peer keeps its own offer; nothing about this remote one
          // is applied.
          return { applied: false, answered: false, ignored: true };
        }
        if (rollback) {
          // Only ever reached from have-local-offer: the chain guarantees no
          // half-built local offer is outstanding, so this rollback is legal.
          generation++;
          await peer.setLocalDescription({ type: "rollback" });
        }
        await peer.setRemoteDescription(description);
        await drainPendingCandidates();
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        send({ type: "call_answer", sdp: describe(peer.localDescription) });
        return { applied: true, answered: true, ignored: false };
      });
    },

    /**
     * Adds a candidate, or holds it until the description it belongs to
     * arrives. Federated hops are independent HTTP requests, so a candidate
     * routinely overtakes its offer; adding it early throws, and dropping it
     * costs a usable network path.
     */
    acceptCandidate(candidate) {
      if (!candidate) return Promise.resolve({ queued: false, applied: false });
      return serialize(async () => {
        if (!peer.remoteDescription) {
          pending.push(candidate);
          return { queued: true, applied: false };
        }
        try {
          await peer.addIceCandidate(candidate);
        } catch (error) {
          if (!negotiation.mayDropCandidate()) throw error;
          return { queued: false, applied: false };
        }
        return { queued: false, applied: true };
      });
    },

    /** Sends a locally gathered candidate to the peer. */
    emitCandidate(candidate) {
      if (!candidate) return;
      send({
        type: "ice_candidate",
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        },
      });
    },

    /** Discards buffered candidates, used after a reconnection. */
    dropPendingCandidates() {
      pending.drain();
    },

    /** Resolves once every queued SDP operation has settled. */
    settled() {
      return operations;
    },
  };
}

function describe(description) {
  return description ? { type: description.type, sdp: description.sdp } : null;
}
