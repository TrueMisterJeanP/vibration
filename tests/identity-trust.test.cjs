const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "web/js/identity-trust.js"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");

async function loadModule() {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

(async () => {
  const trust = await loadModule();
  const stored = new Map();
  let tick = 0;
  const registry = trust.createIdentityTrustRegistry({
    readRecord: async (id) => stored.get(id),
    writeRecord: async (record) => stored.set(record.id, structuredClone(record)),
    now: () => `2026-08-08T12:00:0${tick++}.000Z`,
  });
  const keyA = { kty: "EC", crv: "P-256", x: "first-x", y: "first-y", ext: true };
  const keyAReordered = { y: "first-y", x: "first-x", crv: "P-256", kty: "EC" };
  const keyB = { kty: "EC", crv: "P-256", x: "second-x", y: "second-y" };
  const identityA = {
    instanceURL: "https://chat.example.test/",
    userID: 42,
    username: "alice",
    displayName: "Alice",
    publicKey: JSON.stringify(keyA),
  };

  const first = await registry.observeIdentityKey(identityA);
  assert.equal(first.status, "observed");
  assert.equal(first.record.verifiedAt, null);
  assert.equal(first.record.pendingPublicKey, undefined);
  assert.match(trust.formatPublicKeyFingerprint(first.record.fingerprint), /^[0-9A-F]{4}( [0-9A-F]{4}){15}$/);

  const unchanged = await registry.observeIdentityKey({ ...identityA, publicKey: keyAReordered });
  assert.equal(unchanged.status, "observed");
  assert.equal(unchanged.record.fingerprint, first.record.fingerprint);

  const verified = await registry.markIdentityVerified(identityA, first.record.fingerprint);
  assert.equal(verified.status, "verified");
  assert.ok(verified.record.verifiedAt);

  const changed = await registry.observeIdentityKey({ ...identityA, publicKey: keyB });
  assert.equal(changed.status, "changed");
  assert.equal(changed.record.publicKey, trust.canonicalPublicKey(keyA));
  assert.equal(changed.record.pendingPublicKey, trust.canonicalPublicKey(keyB));
  assert.notEqual(changed.record.pendingFingerprint, changed.record.fingerprint);

  const oldKeySeenAgain = await registry.observeIdentityKey(identityA);
  assert.equal(oldKeySeenAgain.status, "changed", "a pending change cannot disappear silently");
  await assert.rejects(
    registry.markIdentityVerified(identityA, first.record.fingerprint),
    /doit d’abord être acceptée/,
  );

  await assert.rejects(
    registry.acceptPendingIdentity(identityA, "NOT-THE-DISPLAYED-FINGERPRINT"),
    /changé pendant la confirmation/,
  );
  const accepted = await registry.acceptPendingIdentity(identityA, changed.record.pendingFingerprint);
  assert.equal(accepted.status, "observed");
  assert.equal(accepted.record.publicKey, trust.canonicalPublicKey(keyB));
  assert.equal(accepted.record.verifiedAt, null);
  assert.equal(accepted.record.history.at(-1).fingerprint, first.record.fingerprint);
  assert.equal(accepted.record.history.at(-1).publicKey, trust.canonicalPublicKey(keyA));

  const otherInstance = await registry.observeIdentityKey({
    ...identityA,
    instanceURL: "https://other.example.test",
    publicKey: keyA,
  });
  assert.equal(otherInstance.status, "observed");
  assert.notEqual(otherInstance.record.id, accepted.record.id);

  const signingIdentity = { ...identityA, userID: 77 };
  const beforeSigning = await registry.observeIdentityKey(signingIdentity);
  const signingA = JSON.stringify({ kty: "EC", crv: "P-256", x: "signing-a-x", y: "signing-a-y" });
  const signingB = JSON.stringify({ kty: "EC", crv: "P-256", x: "signing-b-x", y: "signing-b-y" });
  const upgradedSigning = await registry.observeIdentityKey({ ...signingIdentity, signingPublicKey: signingA, signingKeyID: "key-a" });
  assert.equal(upgradedSigning.status, "observed", "an unverified identity may receive its first signing key as a TOFU upgrade");
  assert.notEqual(upgradedSigning.record.fingerprint, beforeSigning.record.fingerprint);
  const changedSigning = await registry.observeIdentityKey({ ...signingIdentity, signingPublicKey: signingB, signingKeyID: "key-b" });
  assert.equal(changedSigning.status, "changed", "a later signing key replacement must be blocked");
  assert.equal(changedSigning.record.signingPublicKey, trust.canonicalPublicKey(signingA));
  assert.equal(changedSigning.record.pendingSigningPublicKey, trust.canonicalPublicKey(signingB));

  const verifiedSigningIdentity = { ...identityA, userID: 78 };
  const verifiedBeforeSigning = await registry.observeIdentityKey(verifiedSigningIdentity);
  await registry.markIdentityVerified(verifiedSigningIdentity, verifiedBeforeSigning.record.fingerprint);
  const verifiedSigningUpgrade = await registry.observeIdentityKey({ ...verifiedSigningIdentity, signingPublicKey: signingA, signingKeyID: "key-a" });
  assert.equal(verifiedSigningUpgrade.status, "changed", "a verified identity must not acquire a signing key silently");
  assert.equal(verifiedSigningUpgrade.record.signingPublicKey, "");
  assert.equal(verifiedSigningUpgrade.record.pendingSigningPublicKey, trust.canonicalPublicKey(signingA));

  await assert.rejects(
    registry.observeIdentityKey({ ...identityA, userID: 99, publicKey: { kty: "RSA" } }),
    /Clé publique invalide/,
  );

  assert.match(app, /observeIdentityKey\(identityTrustInput\(identity\)\)/);
  assert.match(app, /getMembers\(conversation\.id, \{ fresh: true, interactive: true \}\)/);
  assert.match(app, /acceptPendingIdentity\(identityTrustInput\(identity\), current\.record\.pendingFingerprint\)/);
  assert.ok(
    app.indexOf("const members = await getMembers(conversation.id);")
      < app.indexOf("if (state.keys.has(cacheID)) return state.keys.get(cacheID);"),
    "member identities are checked before a cached conversation key is reused",
  );
  assert.match(html, /id="profile-identity-fingerprint"/);
  assert.match(html, /id="conversation-info-fingerprint"/);
  assert.match(html, /id="conversation-info-verify"/);

  console.log("Identity trust: first use, persistent comparison, blocking change and explicit acceptance verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
