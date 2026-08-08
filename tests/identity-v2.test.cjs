const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
globalThis.hashwasm = require("hash-wasm");

const source = fs.readFileSync(path.join(__dirname, "../web/js/crypto.js"), "utf8");
const loginHTML = fs.readFileSync(path.join(__dirname, "../web/login.html"), "utf8");
const appHTML = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");

async function cryptoModule() {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

async function legacyIdentity(phrase) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const privateJWK = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey("raw", new TextEncoder().encode(phrase), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const data = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(privateJWK)));
  return {
    privateJWK,
    user: {
      encrypted_private_key: JSON.stringify({ v: 1, iv: Buffer.from(iv).toString("base64"), data: Buffer.from(data).toString("base64") }),
      crypto_salt: Buffer.from(salt).toString("base64"),
    },
  };
}

(async () => {
  for (const html of [loginHTML, appHTML]) {
    const argonScript = html.indexOf('/vendor/hash-wasm/argon2.umd.min.js?v=identity-v2');
    const moduleScript = html.indexOf('type="module"', argonScript);
    assert.ok(argonScript >= 0 && moduleScript > argonScript, "the local Argon2id runtime must load before the application module");
  }
  const module = await cryptoModule();
  const phrase = "rivage cuivre faucon tulipe monde quartz";
  const identity = await module.createIdentity(phrase);
  const envelope = JSON.parse(identity.encrypted_private_key);
  assert.equal(envelope.v, 2);
  assert.equal(envelope.kdf.name, "argon2id");
  assert.equal(envelope.kdf.memory_kib, 32768);
  assert.equal(identity.crypto_salt, "argon2id-v2");
  assert.equal(identity.signing_key_id, await module.signingKeyID(identity.signing_public_key));

  const bundle = await module.decryptIdentityBundle(identity, phrase);
  assert.equal(bundle.v, 2);
  assert.ok(bundle.encryption_private_key.d);
  assert.ok(bundle.signing_private_key.d);
  await assert.rejects(module.decryptIdentityBundle(identity, `${phrase} erreur`), /Phrase secrète incorrecte/);

  const legacy = await legacyIdentity("abcdefghij");
  const upgraded = await module.upgradeIdentityEnvelope(legacy.user, "abcdefghij");
  assert.equal(upgraded.bundle.encryption_private_key.d, legacy.privateJWK.d, "migration must preserve the ECDH identity");
  assert.equal(JSON.parse(upgraded.update.encrypted_private_key).v, 2);
  assert.ok(upgraded.update.signing_public_key);

  const unlocked = await module.importIdentityBundle(bundle);
  const message = {
    kind: "text", conversation_id: 42, sender_id: 7, key_epoch: 1, reply_to: null,
    encrypted_content: "ciphertext", iv: "message-iv-value",
  };
  const signature = await module.signMessagePayload(unlocked.signingPrivateKey, unlocked.signingKeyID, message);
  const stored = {
    ...message,
    ...signature,
    message_kind: "text",
    signature_conversation_id: "42",
    signature_sender_id: "7",
    signature_reply_to: "",
  };
  assert.deepEqual(await module.verifyMessagePayload(identity.signing_public_key, stored), { valid: true, legacy: false });
  assert.deepEqual(await module.verifyMessagePayload(identity.signing_public_key, { ...stored, encrypted_content: "tampered" }), { valid: false, legacy: false });

  console.log("Identity v2: Argon2id creation/migration and authenticated message tamper detection verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
