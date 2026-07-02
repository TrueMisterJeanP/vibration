import {
  base64ToBytes,
  bytesToBase64,
  decryptIdentityJWK,
  importIdentityJWK,
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
  const privateJWK = await decryptIdentityJWK(user, phrase);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deviceKey();
  const clear = new TextEncoder().encode(JSON.stringify(privateJWK));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, clear);
  await writeRecord({
    id: identityID(user.id),
    publicKey: user.public_key,
    iv: bytesToBase64(iv),
    data: bytesToBase64(encrypted),
  });
  return importIdentityJWK(privateJWK);
}

export async function loadRememberedIdentity(user) {
  const saved = await readRecord(identityID(user.id));
  if (!saved || saved.publicKey !== user.public_key) return null;
  try {
    const key = await deviceKey();
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(saved.iv) },
      key,
      base64ToBytes(saved.data),
    );
    return importIdentityJWK(JSON.parse(new TextDecoder().decode(clear)));
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
