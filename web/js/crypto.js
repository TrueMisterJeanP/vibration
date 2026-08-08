const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const NEW_PASSPHRASE_POLICY_MESSAGE = "Utilisez au moins 6 mots sans lien entre eux (32 caractères minimum) ou 24 caractères variés.";

const COMMON_PASSPHRASES = [
  "mot de passe",
  "phrase secrete",
  "phrase secrète",
  "password",
  "passphrase",
  "correct horse battery staple",
];

// 64 fragments equiprobable. Six words de trois fragments donnent 108 bits
// d'aléa lorsque la phrase est créée avec crypto.getRandomValues().
const PASSPHRASE_FRAGMENTS = [
  "ba", "be", "bi", "bo", "bu", "ca", "ce", "ci", "co", "cu",
  "da", "de", "di", "do", "du", "fa", "fe", "fi", "fo", "fu",
  "ga", "ge", "gi", "go", "gu", "ka", "ke", "ki", "ko", "ku",
  "la", "le", "li", "lo", "lu", "ma", "me", "mi", "mo", "mu",
  "na", "ne", "ni", "no", "nu", "pa", "pe", "pi", "po", "pu",
  "ra", "re", "ri", "ro", "ru", "sa", "se", "si", "so", "su",
  "ta", "te", "ti", "to",
];

export function assessNewPassphrase(phrase) {
  const value = String(phrase || "");
  if (!value) return { valid: false, score: 0, reason: "empty" };

  const normalized = value.normalize("NFKC").trim().toLocaleLowerCase("fr");
  const length = [...normalized].length;
  const words = normalized.split(/\s+/u).filter(Boolean);
  const uniqueWords = new Set(words);
  const uniqueCharacters = new Set([...normalized.replace(/\s/gu, "")]);
  const characterClasses = [
    /\p{Ll}/u,
    /\p{Lu}/u,
    /\p{N}/u,
    /[^\p{L}\p{N}\s]/u,
  ].filter((pattern) => pattern.test(value)).length;
  const predictable = COMMON_PASSPHRASES.some((common) => normalized.includes(common))
    || /^(.)\1{7,}$/u.test(normalized)
    || /^(.{1,12})\1{2,}$/u.test(normalized)
    || /(012345|123456|234567|abcdef|azerty|qwerty)/u.test(normalized);
  const wordPhrase = length >= 32
    && words.length >= 6
    && uniqueWords.size === words.length
    && words.every((word) => [...word].length >= 3);
  const variedPhrase = length >= 24
    && characterClasses >= 3
    && uniqueCharacters.size >= 14;
  const valid = !predictable && (wordPhrase || variedPhrase);

  return {
    valid,
    score: valid ? 4 : (length >= 16 && (words.length >= 4 || characterClasses >= 2) ? 2 : 1),
    reason: valid ? (wordPhrase ? "word-phrase" : "varied-phrase") : "weak",
    length,
    wordCount: words.length,
    characterClasses,
  };
}

export function validateNewPassphrase(phrase) {
  const assessment = assessNewPassphrase(phrase);
  if (!assessment.valid) {
    throw new Error(`Phrase secrète trop faible. ${NEW_PASSPHRASE_POLICY_MESSAGE}`);
  }
  return assessment;
}

export function generateStrongPassphrase() {
  for (;;) {
    const random = crypto.getRandomValues(new Uint8Array(18));
    const words = [];
    for (let wordIndex = 0; wordIndex < 6; wordIndex += 1) {
      let word = "";
      for (let fragmentIndex = 0; fragmentIndex < 3; fragmentIndex += 1) {
        word += PASSPHRASE_FRAGMENTS[random[(wordIndex * 3) + fragmentIndex] & 63];
      }
      words.push(word);
    }
    const phrase = words.join(" ");
    if (assessNewPassphrase(phrase).valid) return phrase;
  }
}

export function bytesToBase64(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function phraseKey(phrase, salt) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(phrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const IDENTITY_ENVELOPE_VERSION = 2;
const ARGON2ID_PARAMETERS = Object.freeze({
  memory_kib: 32768,
  iterations: 3,
  parallelism: 1,
  hash_length: 32,
});

function argon2Implementation() {
  const implementation = globalThis.hashwasm?.argon2id;
  if (typeof implementation !== "function") {
    throw new Error("Le module de protection Argon2id n’est pas disponible.");
  }
  return implementation;
}

async function argon2IdentityKey(phrase, salt, parameters = ARGON2ID_PARAMETERS) {
  const raw = await argon2Implementation()({
    password: String(phrase),
    salt,
    parallelism: Number(parameters.parallelism),
    iterations: Number(parameters.iterations),
    memorySize: Number(parameters.memory_kib),
    hashLength: Number(parameters.hash_length),
    outputType: "binary",
  });
  try {
    return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

function publicSigningJWK(jwk) {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

function canonicalSigningPublicKey(jwkOrText) {
  const jwk = typeof jwkOrText === "string" ? JSON.parse(jwkOrText) : jwkOrText;
  if (jwk?.kty !== "EC" || jwk?.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Clé publique de signature invalide.");
  }
  return JSON.stringify(publicSigningJWK(jwk));
}

export async function signingKeyID(jwkOrText) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(canonicalSigningPublicKey(jwkOrText))));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptIdentityV2(phrase, encryptionPrivateJWK, signingPrivateJWK) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const publicKey = publicSigningJWK(signingPrivateJWK);
  const keyID = await signingKeyID(publicKey);
  const payload = {
    v: IDENTITY_ENVELOPE_VERSION,
    encryption_private_key: encryptionPrivateJWK,
    signing_private_key: signingPrivateJWK,
    signing_key_id: keyID,
  };
  const key = await argon2IdentityKey(phrase, salt);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(payload)));
  return {
    encrypted_private_key: JSON.stringify({
      v: IDENTITY_ENVELOPE_VERSION,
      kdf: {
        name: "argon2id",
        version: 19,
        ...ARGON2ID_PARAMETERS,
        salt: bytesToBase64(salt),
      },
      cipher: { name: "AES-GCM", iv: bytesToBase64(iv) },
      data: bytesToBase64(encrypted),
    }),
    crypto_salt: "argon2id-v2",
    signing_public_key: canonicalSigningPublicKey(publicKey),
    signing_key_id: keyID,
  };
}

export async function createIdentity(phrase) {
  validateNewPassphrase(phrase);
  const encryptionPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const signingPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicJWK = await crypto.subtle.exportKey("jwk", encryptionPair.publicKey);
  const privateJWK = await crypto.subtle.exportKey("jwk", encryptionPair.privateKey);
  const signingPrivateJWK = await crypto.subtle.exportKey("jwk", signingPair.privateKey);
  return {
    public_key: JSON.stringify(publicJWK),
    ...await encryptIdentityV2(phrase, privateJWK, signingPrivateJWK),
  };
}

export async function decryptIdentityBundle(user, phrase) {
  try {
    const envelope = JSON.parse(user.encrypted_private_key);
    if (envelope.v === IDENTITY_ENVELOPE_VERSION) {
      if (envelope.kdf?.name !== "argon2id" || envelope.kdf?.version !== 19 || envelope.cipher?.name !== "AES-GCM") {
        throw new Error("unsupported identity envelope");
      }
      const parameters = envelope.kdf;
      if (parameters.memory_kib < 8192 || parameters.memory_kib > 262144 || parameters.iterations < 1 || parameters.iterations > 10 ||
          parameters.parallelism < 1 || parameters.parallelism > 4 || parameters.hash_length !== 32) {
        throw new Error("invalid Argon2id parameters");
      }
      const key = await argon2IdentityKey(phrase, base64ToBytes(parameters.salt), parameters);
      const clear = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(envelope.cipher.iv) },
        key,
        base64ToBytes(envelope.data),
      );
      const bundle = JSON.parse(decoder.decode(clear));
      if (bundle.v !== IDENTITY_ENVELOPE_VERSION || !bundle.encryption_private_key || !bundle.signing_private_key ||
          bundle.signing_key_id !== await signingKeyID(bundle.signing_private_key)) {
        throw new Error("invalid identity bundle");
      }
      return bundle;
    }
    const key = await phraseKey(phrase, base64ToBytes(user.crypto_salt));
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.data),
    );
    return { v: 1, encryption_private_key: JSON.parse(decoder.decode(clear)), signing_private_key: null, signing_key_id: "" };
  } catch {
    throw new Error("Phrase secrète incorrecte.");
  }
}

export async function decryptIdentityJWK(user, phrase) {
  return (await decryptIdentityBundle(user, phrase)).encryption_private_key;
}

export async function upgradeIdentityEnvelope(user, phrase) {
  const bundle = await decryptIdentityBundle(user, phrase);
  if (bundle.v === IDENTITY_ENVELOPE_VERSION) {
    return { bundle, update: null };
  }
  const signingPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const signingPrivateJWK = await crypto.subtle.exportKey("jwk", signingPair.privateKey);
  const update = await encryptIdentityV2(phrase, bundle.encryption_private_key, signingPrivateJWK);
  return {
    bundle: {
      v: IDENTITY_ENVELOPE_VERSION,
      encryption_private_key: bundle.encryption_private_key,
      signing_private_key: signingPrivateJWK,
      signing_key_id: update.signing_key_id,
    },
    update,
  };
}

export async function importIdentityJWK(privateJWK) {
  return crypto.subtle.importKey(
    "jwk",
    privateJWK,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

export async function importSigningIdentityJWK(privateJWK) {
  return crypto.subtle.importKey(
    "jwk",
    privateJWK,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function importIdentityBundle(bundle) {
  return {
    privateKey: await importIdentityJWK(bundle.encryption_private_key),
    signingPrivateKey: bundle.signing_private_key ? await importSigningIdentityJWK(bundle.signing_private_key) : null,
    signingKeyID: bundle.signing_key_id || "",
  };
}

export function canonicalMessageSignaturePayload(input) {
  const replyTo = input.reply_to == null ? "" : String(input.reply_to);
  return JSON.stringify({
    v: 1,
    kind: String(input.kind || "text"),
    conversation_id: String(input.conversation_id),
    sender_id: String(input.sender_id),
    client_message_id: String(input.client_message_id),
    revision: Number(input.revision || 1),
    key_epoch: Number(input.key_epoch || 1),
    reply_to: replyTo,
    encrypted_content: String(input.encrypted_content || ""),
    iv: String(input.iv || ""),
    option_count: Number(input.option_count || 0),
    starts_at: String(input.starts_at || ""),
    ends_at: String(input.ends_at || ""),
    encrypted_name: String(input.encrypted_name || ""),
    encrypted_mime: String(input.encrypted_mime || ""),
    ciphertext_sha256: String(input.ciphertext_sha256 || ""),
    preview_sha256: String(input.preview_sha256 || ""),
  });
}

export async function signMessagePayload(signingPrivateKey, signingKeyIDValue, input) {
  if (!signingPrivateKey || !signingKeyIDValue) throw new Error("Identité de signature non déverrouillée.");
  const clientMessageID = input.client_message_id || crypto.randomUUID();
  const revision = Number(input.revision || 1);
  const payload = { ...input, client_message_id: clientMessageID, revision };
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingPrivateKey,
    encoder.encode(canonicalMessageSignaturePayload(payload)),
  );
  return {
    client_message_id: clientMessageID,
    signature_version: 1,
    signing_key_id: signingKeyIDValue,
    signature: bytesToBase64(signature),
    revision,
  };
}

export async function verifyMessagePayload(signingPublicKey, message, extra = {}) {
  if (!message?.signature_version) return { valid: false, legacy: true };
  if (message.signature_version !== 1 || !signingPublicKey || !message.signature) return { valid: false, legacy: false };
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(canonicalSigningPublicKey(signingPublicKey)),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64ToBytes(message.signature),
      encoder.encode(canonicalMessageSignaturePayload({
        kind: message.message_kind,
        conversation_id: message.signature_conversation_id || message.conversation_id,
        sender_id: message.signature_sender_id || message.sender_id,
        client_message_id: message.client_message_id,
        revision: message.revision,
        key_epoch: message.key_epoch,
        reply_to: Object.prototype.hasOwnProperty.call(message, "signature_reply_to") ? message.signature_reply_to : message.reply_to,
        encrypted_content: message.encrypted_content,
        iv: message.iv,
        option_count: message.poll?.options?.length || 0,
        starts_at: message.event?.starts_at,
        ends_at: message.event?.ends_at,
        encrypted_name: message.file?.encrypted_name,
        encrypted_mime: message.file?.encrypted_mime,
        ciphertext_sha256: message.file?.ciphertext_sha256,
        preview_sha256: message.file?.preview_sha256,
        ...extra,
      })),
    );
    return { valid, legacy: false };
  } catch {
    return { valid: false, legacy: false };
  }
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function unlockIdentity(user, phrase) {
  return importIdentityJWK(await decryptIdentityJWK(user, phrase));
}

async function sharedKey(privateKey, publicKeyText, salt, info) {
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(publicKeyText),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function privateConversationKey(privateKey, peerPublicKey, conversationID, keyID = "") {
  return sharedKey(
    privateKey,
    peerPublicKey,
    encoder.encode(keyID || `chat-private-v1:${conversationID}`),
    "chat-pwa-go conversation key",
  );
}

export async function generateGroupKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function generateShareKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function exportShareKey(key) {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return bytesToBase64(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function importShareKey(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const raw = base64ToBytes(padded);
  if (raw.length !== 32) throw new Error("Clé de partage invalide.");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
}

export async function wrapGroupKey(groupKey, privateKey, memberPublicKey, senderID) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrappingKey = await sharedKey(privateKey, memberPublicKey, salt, "chat-pwa-go group key wrapping");
  const raw = await crypto.subtle.exportKey("raw", groupKey);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrappingKey, raw);
  return JSON.stringify({
    v: 1,
    sender_id: senderID,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(data),
  });
}

export async function unwrapGroupKey(envelopeText, privateKey, senderPublicKey) {
  const envelope = JSON.parse(envelopeText);
  const wrappingKey = await sharedKey(
    privateKey,
    senderPublicKey,
    base64ToBytes(envelope.salt),
    "chat-pwa-go group key wrapping",
  );
  const raw = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
    wrappingKey,
    base64ToBytes(envelope.data),
  );
  // The owner must be able to wrap this same group key for members added later.
  return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
}

export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return { iv: bytesToBase64(iv), data: bytesToBase64(data) };
}

export async function decryptBytes(key, data, iv) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(data));
}

export async function encryptText(key, text) {
  return encryptBytes(key, encoder.encode(text));
}

export async function decryptText(key, data, iv) {
  return decoder.decode(await decryptBytes(key, data, iv));
}

export async function encryptEnvelope(key, text) {
  return JSON.stringify(await encryptText(key, text));
}

export async function decryptEnvelope(key, text) {
  const envelope = JSON.parse(text);
  return decryptText(key, envelope.data, envelope.iv);
}
