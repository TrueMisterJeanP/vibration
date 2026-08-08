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

export async function createIdentity(phrase) {
  validateNewPassphrase(phrase);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicJWK = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJWK = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await phraseKey(phrase, salt);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(privateJWK)));
  return {
    public_key: JSON.stringify(publicJWK),
    encrypted_private_key: JSON.stringify({ v: 1, iv: bytesToBase64(iv), data: bytesToBase64(encrypted) }),
    crypto_salt: bytesToBase64(salt),
  };
}

export async function decryptIdentityJWK(user, phrase) {
  try {
    const envelope = JSON.parse(user.encrypted_private_key);
    const key = await phraseKey(phrase, base64ToBytes(user.crypto_salt));
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.data),
    );
    return JSON.parse(decoder.decode(clear));
  } catch {
    throw new Error("Phrase secrète incorrecte.");
  }
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
