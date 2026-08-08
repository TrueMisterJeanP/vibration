const DB_NAME = "vibration-identity-trust";
const DB_VERSION = 1;
const STORE_NAME = "identities";
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Lecture des identités impossible."));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Enregistrement de l’identité impossible."));
    transaction.onabort = () => reject(transaction.error || new Error("Enregistrement de l’identité interrompu."));
  });
}

function openDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Le stockage local des identités est indisponible."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Le registre local des identités ne peut pas être ouvert."));
  });
}

async function readPersistentRecord(id) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    return await requestResult(transaction.objectStore(STORE_NAME).get(id));
  } finally {
    database.close();
  }
}

async function writePersistentRecord(record) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const completion = transactionResult(transaction);
    transaction.objectStore(STORE_NAME).put(record);
    await completion;
  } finally {
    database.close();
  }
}

function normalizeInstance(value) {
  const source = String(value || "").trim();
  if (!source) throw new Error("Instance inconnue pour cette identité.");
  try {
    const url = new URL(source);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("Instance invalide pour cette identité.");
  }
}

function normalizedUserID(value) {
  const userID = String(value ?? "").trim();
  if (!userID) throw new Error("Utilisateur inconnu pour cette identité.");
  return userID;
}

export function identityTrustID(instanceURL, userID) {
  return JSON.stringify([normalizeInstance(instanceURL), normalizedUserID(userID)]);
}

export function canonicalPublicKey(publicKey) {
  let parsed;
  try {
    parsed = typeof publicKey === "string" ? JSON.parse(publicKey) : publicKey;
  } catch {
    throw new Error("Clé publique invalide.");
  }
  if (
    !parsed
    || parsed.kty !== "EC"
    || parsed.crv !== "P-256"
    || typeof parsed.x !== "string"
    || !parsed.x
    || typeof parsed.y !== "string"
    || !parsed.y
  ) {
    throw new Error("Clé publique invalide.");
  }
  return JSON.stringify({ kty: "EC", crv: "P-256", x: parsed.x, y: parsed.y });
}

export async function publicKeyFingerprint(publicKey) {
  const canonical = canonicalPublicKey(publicKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export function formatPublicKeyFingerprint(fingerprint) {
  return String(fingerprint || "").replace(/\s+/g, "").match(/.{1,4}/g)?.join(" ") || "";
}

function publicIdentity(input) {
  const signingSupplied = Object.prototype.hasOwnProperty.call(input, "signingPublicKey");
  const signingPublicKey = signingSupplied ? (input.signingPublicKey ? canonicalPublicKey(input.signingPublicKey) : "") : null;
  return {
    id: identityTrustID(input.instanceURL, input.userID),
    instanceURL: normalizeInstance(input.instanceURL),
    userID: normalizedUserID(input.userID),
    username: String(input.username || ""),
    displayName: String(input.displayName || ""),
    publicKey: canonicalPublicKey(input.publicKey),
    signingPublicKey,
    signingKeyID: String(input.signingKeyID || ""),
  };
}

async function identityFingerprint(publicKey, signingPublicKey = "") {
  if (!signingPublicKey) return publicKeyFingerprint(publicKey);
  const canonical = JSON.stringify({ encryption: canonicalPublicKey(publicKey), signing: canonicalPublicKey(signingPublicKey) });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function copyRecord(record) {
  if (!record) return null;
  return {
    ...record,
    history: Array.isArray(record.history) ? record.history.map((entry) => ({ ...entry })) : [],
  };
}

export function createIdentityTrustRegistry({ readRecord, writeRecord, now = () => new Date().toISOString() }) {
  const operations = new Map();
  const records = new Map();

  const serialized = (id, operation) => {
    const previous = operations.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    operations.set(id, current);
    return current.finally(() => {
      if (operations.get(id) === current) operations.delete(id);
    });
  };

  const load = async (id) => {
    if (records.has(id)) return copyRecord(records.get(id));
    const record = await readRecord(id);
    records.set(id, record || null);
    return copyRecord(record);
  };

  const save = async (record) => {
    await writeRecord(copyRecord(record));
    records.set(record.id, copyRecord(record));
    return copyRecord(record);
  };

  const observeIdentityKey = async (input) => {
    const identity = publicIdentity(input);
    return serialized(identity.id, async () => {
      const currentBeforeFingerprint = await load(identity.id);
      const observedSigningKey = identity.signingPublicKey === null ? (currentBeforeFingerprint?.signingPublicKey || "") : identity.signingPublicKey;
      const fingerprint = await identityFingerprint(identity.publicKey, observedSigningKey);
      const current = currentBeforeFingerprint;
      const observedAt = now();
      if (!current) {
        const record = await save({
          id: identity.id,
          instanceURL: identity.instanceURL,
          userID: identity.userID,
          username: identity.username,
          displayName: identity.displayName,
          publicKey: identity.publicKey,
          signingPublicKey: identity.signingPublicKey || "",
          signingKeyID: identity.signingKeyID,
          fingerprint,
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          verifiedAt: null,
          history: [],
        });
        return { status: "observed", record };
      }

      if (current.publicKey === identity.publicKey && !current.signingPublicKey && identity.signingPublicKey &&
          !current.pendingPublicKey && !current.verifiedAt) {
        const record = await save({
          ...current,
          signingPublicKey: identity.signingPublicKey,
          signingKeyID: identity.signingKeyID,
          previousFingerprint: current.fingerprint,
          fingerprint,
          verifiedAt: null,
          lastSeenAt: observedAt,
        });
        return { status: "observed", record };
      }

      const signingMatches = identity.signingPublicKey === null || (current.signingPublicKey || "") === identity.signingPublicKey;
      if (current.publicKey === identity.publicKey && signingMatches && !current.pendingPublicKey && !current.pendingSigningPublicKey) {
        const metadataChanged = (
          (identity.username && identity.username !== current.username)
          || (identity.displayName && identity.displayName !== current.displayName)
        );
        const lastSeenAge = Date.parse(observedAt) - Date.parse(current.lastSeenAt || current.firstSeenAt);
        if (!metadataChanged && Number.isFinite(lastSeenAge) && lastSeenAge < LAST_SEEN_WRITE_INTERVAL_MS) {
          return { status: current.verifiedAt ? "verified" : "observed", record: current };
        }
        const record = await save({
          ...current,
          username: identity.username || current.username,
          displayName: identity.displayName || current.displayName,
          lastSeenAt: observedAt,
        });
        return { status: record.verifiedAt ? "verified" : "observed", record };
      }

      if (current.publicKey !== identity.publicKey || (identity.signingPublicKey !== null && (current.signingPublicKey || "") !== identity.signingPublicKey)) {
        current.pendingPublicKey = identity.publicKey;
        current.pendingSigningPublicKey = identity.signingPublicKey === null ? (current.signingPublicKey || "") : identity.signingPublicKey;
        current.pendingSigningKeyID = identity.signingPublicKey === null ? (current.signingKeyID || "") : identity.signingKeyID;
        current.pendingFingerprint = fingerprint;
        current.changeDetectedAt ||= observedAt;
        current.lastChangedSeenAt = observedAt;
      }
      current.username = identity.username || current.username;
      current.displayName = identity.displayName || current.displayName;
      const record = await save(current);
      return { status: "changed", record };
    });
  };

  const getIdentityTrust = async (input) => {
    const id = identityTrustID(input.instanceURL, input.userID);
    const record = await load(id);
    if (!record) return { status: "unknown", record: null };
    if (record.pendingPublicKey || record.pendingSigningPublicKey) return { status: "changed", record };
    return { status: record.verifiedAt ? "verified" : "observed", record };
  };

  const acceptPendingIdentity = async (input, expectedFingerprint = "") => {
    const id = identityTrustID(input.instanceURL, input.userID);
    return serialized(id, async () => {
      const current = await load(id);
      if (!current?.pendingPublicKey || !current.pendingFingerprint) {
        throw new Error("Aucun changement de clé n’est en attente.");
      }
      if (expectedFingerprint && current.pendingFingerprint !== expectedFingerprint) {
        throw new Error("La nouvelle empreinte a changé pendant la confirmation.");
      }
      const acceptedAt = now();
      const history = [
        ...(current.history || []),
        {
          publicKey: current.publicKey,
          signingPublicKey: current.signingPublicKey || "",
          signingKeyID: current.signingKeyID || "",
          fingerprint: current.fingerprint,
          firstSeenAt: current.firstSeenAt,
          replacedAt: acceptedAt,
        },
      ];
      const record = await save({
        ...current,
        publicKey: current.pendingPublicKey,
        signingPublicKey: current.pendingSigningPublicKey || "",
        signingKeyID: current.pendingSigningKeyID || "",
        fingerprint: current.pendingFingerprint,
        firstSeenAt: acceptedAt,
        lastSeenAt: acceptedAt,
        verifiedAt: null,
        previousFingerprint: current.fingerprint,
        acceptedChangeAt: acceptedAt,
        history,
        pendingPublicKey: null,
        pendingSigningPublicKey: null,
        pendingSigningKeyID: null,
        pendingFingerprint: null,
        changeDetectedAt: null,
        lastChangedSeenAt: null,
      });
      return { status: "observed", record };
    });
  };

  const markIdentityVerified = async (input, expectedFingerprint = "") => {
    const id = identityTrustID(input.instanceURL, input.userID);
    return serialized(id, async () => {
      const current = await load(id);
      if (!current) throw new Error("Cette identité n’a pas encore été observée.");
      if (current.pendingPublicKey || current.pendingSigningPublicKey) throw new Error("La nouvelle clé doit d’abord être acceptée.");
      if (expectedFingerprint && current.fingerprint !== expectedFingerprint) {
        throw new Error("L’empreinte a changé pendant la vérification.");
      }
      const record = await save({ ...current, verifiedAt: now() });
      return { status: "verified", record };
    });
  };

  return { observeIdentityKey, getIdentityTrust, acceptPendingIdentity, markIdentityVerified };
}

const persistentRegistry = createIdentityTrustRegistry({
  readRecord: readPersistentRecord,
  writeRecord: writePersistentRecord,
});

export const observeIdentityKey = persistentRegistry.observeIdentityKey;
export const getIdentityTrust = persistentRegistry.getIdentityTrust;
export const acceptPendingIdentity = persistentRegistry.acceptPendingIdentity;
export const markIdentityVerified = persistentRegistry.markIdentityVerified;
