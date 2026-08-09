import {
  base64ToBytes,
  bytesToBase64,
  decryptIdentityBundle,
  importIdentityBundle,
} from "./crypto.js";

const DB_NAME = "chat-secure-device-vault";
const STORE_NAME = "vault";
const DEVICE_KEY_ID = "device-key";
const MIN_VERIFICATION_INTERVAL = 20;
const MAX_VERIFICATION_INTERVAL = 40;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openVault() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readRecord(id) {
  const database = await openVault();
  try {
    return await requestResult(database.transaction(STORE_NAME).objectStore(STORE_NAME).get(id));
  } finally {
    database.close();
  }
}

async function writeRecord(record) {
  const database = await openVault();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    await requestResult(transaction.objectStore(STORE_NAME).put(record));
  } finally {
    database.close();
  }
}

async function deleteRecord(id) {
  const database = await openVault();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    await requestResult(transaction.objectStore(STORE_NAME).delete(id));
  } finally {
    database.close();
  }
}

async function deviceKey() {
  const saved = await readRecord(DEVICE_KEY_ID);
  if (saved?.key) return saved.key;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  await writeRecord({ id: DEVICE_KEY_ID, key });
  return key;
}

function identityID(userID) {
  return `identity:${userID}`;
}

function loginCounterID(userID) {
  return `login-counter:${userID}`;
}

function trustedDeviceID(instanceURL) {
  const url = new URL(instanceURL, location.origin);
  url.hash = "";
  url.search = "";
  return `trusted-device:${url.toString().replace(/\/$/, "")}`;
}

function canonicalDevicePublicKey(jwk) {
  return JSON.stringify({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y });
}

async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function trustedDeviceCredential(instanceURL) {
  const id = trustedDeviceID(instanceURL);
  let saved = await readRecord(id);
  if (!saved?.privateKey || !saved?.publicKey || !saved?.keyID) {
    const generated = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const privateJWK = await crypto.subtle.exportKey("jwk", generated.privateKey);
    const publicJWK = await crypto.subtle.exportKey("jwk", generated.publicKey);
    const publicKey = canonicalDevicePublicKey(publicJWK);
    const keyID = await sha256Hex(publicKey);
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      privateJWK,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    saved = { id, privateKey, publicKey, keyID, createdAt: new Date().toISOString() };
    await writeRecord(saved);
  }
  return {
    device_key_id: saved.keyID,
    device_public_key: saved.publicKey,
  };
}

export async function signTrustedDeviceChallenge(instanceURL, challenge) {
  const id = trustedDeviceID(instanceURL);
  const saved = await readRecord(id);
  if (!saved?.privateKey || !saved?.keyID) throw new Error("Clé de l’appareil indisponible");
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    saved.privateKey,
    new TextEncoder().encode(challenge),
  );
  return {
    device_key_id: saved.keyID,
    challenge,
    signature: bytesToBase64(signature),
  };
}

export async function forgetTrustedDeviceCredential(instanceURL) {
  await deleteRecord(trustedDeviceID(instanceURL));
}

function nextVerificationThreshold() {
  const range = MAX_VERIFICATION_INTERVAL - MIN_VERIFICATION_INTERVAL + 1;
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return MIN_VERIFICATION_INTERVAL + (random[0] % range);
}

function validVerificationThreshold(value) {
  return Number.isInteger(value)
    && value >= MIN_VERIFICATION_INTERVAL
    && value <= MAX_VERIFICATION_INTERVAL;
}

export async function rememberIdentity(user, phrase) {
  const bundle = await decryptIdentityBundle(user, phrase);
  return rememberIdentityBundle(user, bundle);
}

export async function rememberIdentityBundle(user, bundle) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deviceKey();
  const clear = new TextEncoder().encode(JSON.stringify(bundle));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, clear);
  await writeRecord({
    id: identityID(user.id),
    publicKey: user.public_key,
    signingKeyID: user.signing_key_id || bundle.signing_key_id || "",
    iv: bytesToBase64(iv),
    data: bytesToBase64(encrypted),
  });
  return importIdentityBundle(bundle);
}

export async function loadRememberedIdentity(user) {
  const saved = await readRecord(identityID(user.id));
  if (!saved || saved.publicKey !== user.public_key || (user.signing_key_id || "") !== (saved.signingKeyID || "")) return null;
  try {
    const key = await deviceKey();
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(saved.iv) },
      key,
      base64ToBytes(saved.data),
    );
    const stored = JSON.parse(new TextDecoder().decode(clear));
    const bundle = stored?.encryption_private_key
      ? stored
      : { v: 1, encryption_private_key: stored, signing_private_key: null, signing_key_id: "" };
    return importIdentityBundle(bundle);
  } catch {
    await deleteRecord(identityID(user.id));
    return null;
  }
}

export async function hasRememberedIdentity(userID) {
  return Boolean(await readRecord(identityID(userID)));
}

export async function forgetRememberedIdentity(userID) {
  await deleteRecord(identityID(userID));
}

export async function recordSuccessfulLogin(userID) {
  const id = loginCounterID(userID);
  const saved = await readRecord(id);
  if (!saved?.verified) {
    return true;
  }
  const threshold = validVerificationThreshold(saved.threshold)
    ? saved.threshold
    : nextVerificationThreshold();
  const count = (saved.count || 0) + 1;
  await writeRecord({ id, count, verified: true, threshold });
  return count >= threshold;
}

export async function resetLoginVerificationCounter(userID) {
  await writeRecord({
    id: loginCounterID(userID),
    count: 0,
    verified: true,
    threshold: nextVerificationThreshold(),
  });
}
