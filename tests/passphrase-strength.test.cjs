const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "../web/js/crypto.js"), "utf8");

async function loadCryptoModule() {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
  const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return import(moduleURL);
}

async function legacyIdentityEnvelope(phrase) {
  const encoder = new TextEncoder();
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const privateJWK = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const material = await webcrypto.subtle.importKey("raw", encoder.encode(phrase), "PBKDF2", false, ["deriveKey"]);
  const key = await webcrypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const encrypted = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(privateJWK)),
  );
  const base64 = (bytes) => Buffer.from(bytes).toString("base64");
  return {
    privateJWK,
    user: {
      encrypted_private_key: JSON.stringify({ v: 1, iv: base64(iv), data: base64(encrypted) }),
      crypto_salt: base64(salt),
    },
  };
}

(async () => {
  const cryptoModule = await loadCryptoModule();

  assert.equal(cryptoModule.assessNewPassphrase("abcdefghij").valid, false, "ten characters are no longer sufficient");
  assert.equal(cryptoModule.assessNewPassphrase("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").valid, false, "repetition must be rejected");
  assert.equal(cryptoModule.assessNewPassphrase("rivage cuivre faucon tulipe monde quartz").valid, true, "six unrelated words are accepted");
  assert.equal(cryptoModule.assessNewPassphrase("Rivage#82-Faucon!Lumineux?").valid, true, "a long varied passphrase is accepted");
  await assert.rejects(
    cryptoModule.createIdentity("abcdefghij"),
    /Phrase secrète trop faible/,
    "the cryptographic identity creator must enforce the shared policy",
  );

  const generated = new Set();
  for (let index = 0; index < 20; index += 1) {
    const phrase = cryptoModule.generateStrongPassphrase();
    assert.equal(cryptoModule.assessNewPassphrase(phrase).valid, true, "every generated passphrase must satisfy the policy");
    generated.add(phrase);
  }
  assert.equal(generated.size, 20, "generated passphrases must use fresh cryptographic randomness");

  // A phrase accepted by the former ten-character rule must still unlock its
  // existing encrypted private key. Only new identities are strengthened.
  const legacyPhrase = "abcdefghij";
  const legacy = await legacyIdentityEnvelope(legacyPhrase);
  const decrypted = await cryptoModule.decryptIdentityJWK(legacy.user, legacyPhrase);
  assert.equal(decrypted.d, legacy.privateJWK.d);
  const imported = await cryptoModule.unlockIdentity(legacy.user, legacyPhrase);
  assert.equal(imported.type, "private");

  console.log("Passphrase policy: strong creation, secure generation and legacy-account unlock verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
