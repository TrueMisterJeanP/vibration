const CACHE_DB_NAME = "webtchat-conversation-cache";
const CACHE_DB_VERSION = 1;
const MAX_CACHED_MESSAGES = 100;

const STORES = {
  conversations: "conversations",
  members: "members",
  messages: "messages",
  files: "files",
};

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionResult(transaction, value) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(value);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const conversations = database.createObjectStore(STORES.conversations, { keyPath: "key" });
      conversations.createIndex("scope", "scope", { unique: false });
      const members = database.createObjectStore(STORES.members, { keyPath: "key" });
      members.createIndex("scope", "scope", { unique: false });
      const messages = database.createObjectStore(STORES.messages, { keyPath: "key" });
      messages.createIndex("scope", "scope", { unique: false });
      messages.createIndex("conversation", ["scope", "conversation_id"], { unique: false });
      const files = database.createObjectStore(STORES.files, { keyPath: "key" });
      files.createIndex("scope", "scope", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

function recordKey(scope, kind, id) {
  return `${scope}:${kind}:${String(id)}`;
}

function normalizeScope(instanceURL, user) {
  return JSON.stringify([
    String(instanceURL || "").replace(/\/+$/, ""),
    String(user?.id || ""),
    String(user?.public_key || ""),
  ]);
}

function sameID(left, right) {
  return left != null && right != null && String(left) === String(right);
}

async function readAll(database, storeName, indexName, key) {
  const transaction = database.transaction(storeName, "readonly");
  const request = transaction.objectStore(storeName).index(indexName).getAll(key);
  return requestResult(request);
}

async function readRecord(database, storeName, key) {
  const transaction = database.transaction(storeName, "readonly");
  return requestResult(transaction.objectStore(storeName).get(key));
}

async function writeRecords(database, storeName, records, deletedKeys = []) {
  const transaction = database.transaction(storeName, "readwrite");
  const completion = transactionResult(transaction, true);
  const store = transaction.objectStore(storeName);
  for (const key of deletedKeys) store.delete(key);
  for (const record of records) store.put(record);
  return completion;
}

async function deleteByScope(database, storeName, scope) {
  const records = await readAll(database, storeName, "scope", scope);
  await writeRecords(database, storeName, [], records.map((record) => record.key));
}

function newestMessages(records) {
  return records
    .sort((left, right) => Number(left.message?.id || 0) - Number(right.message?.id || 0))
    .slice(-MAX_CACHED_MESSAGES);
}

export async function openConversationCache(instanceURL, user) {
  let database;
  try {
    database = await openDatabase();
  } catch {
    return null;
  }
  const scope = normalizeScope(instanceURL, user);

  const safe = (operation, fallback) => async (...args) => {
    try {
      return await operation(...args);
    } catch {
      return fallback;
    }
  };

  const getScopedRecords = (storeName) => readAll(database, storeName, "scope", scope);
  const getConversationRecords = async (storeName, conversationID) => {
    const records = await getScopedRecords(storeName);
    return records.filter((record) => sameID(record.conversation_id, conversationID));
  };

  const cache = {
    scope,
    getConversations: safe(async () => {
      const records = await getScopedRecords(STORES.conversations);
      return records
        .sort((left, right) => Number(left.position || 0) - Number(right.position || 0))
        .map((record) => record.conversation);
    }, []),

    saveConversations: safe(async (conversations) => {
      const existing = await getScopedRecords(STORES.conversations);
      const records = conversations.map((conversation, position) => ({
        key: recordKey(scope, "conversation", conversation.id),
        scope,
        position,
        conversation,
      }));
      await writeRecords(database, STORES.conversations, records, existing.map((record) => record.key));
      return true;
    }, false),

    getMembers: safe(async (conversationID) => {
      const record = await readRecord(database, STORES.members, recordKey(scope, "members", conversationID));
      return record?.members || null;
    }, null),

    saveMembers: safe(async (conversationID, members) => {
      await writeRecords(database, STORES.members, [{
        key: recordKey(scope, "members", conversationID),
        scope,
        conversation_id: conversationID,
        members,
      }]);
      return true;
    }, false),

    getMessages: safe(async (conversationID) => {
      const records = await getConversationRecords(STORES.messages, conversationID);
      return newestMessages(records).map((record) => record.message);
    }, []),

    replaceMessages: safe(async (conversationID, messages) => {
      const existing = await getConversationRecords(STORES.messages, conversationID);
      const selected = newestMessages(messages.map((message) => ({
        key: recordKey(scope, "message", message.id),
        scope,
        conversation_id: conversationID,
        message,
      })));
      await writeRecords(database, STORES.messages, selected, existing.map((record) => record.key));
      return true;
    }, false),

    putMessages: safe(async (messages) => {
      if (!messages?.length) return true;
      const conversationIDs = [...new Set(messages.map((message) => String(message.conversation_id)))];
      const existing = (await getScopedRecords(STORES.messages)).filter((record) => conversationIDs.includes(String(record.conversation_id)));
      const mergedByKey = new Map([...existing, ...messages.map((message) => ({
        key: recordKey(scope, "message", message.id),
        scope,
        conversation_id: message.conversation_id,
        message,
      }))].map((record) => [record.key, record]));
      const merged = [...mergedByKey.values()];
      const selected = [];
      for (const conversationID of conversationIDs) {
        selected.push(...newestMessages(merged.filter((record) => String(record.conversation_id) === conversationID)));
      }
      await writeRecords(database, STORES.messages, selected, existing.map((record) => record.key));
      return true;
    }, false),

    deleteMessage: safe(async (conversationID, messageID) => {
      const records = await getConversationRecords(STORES.messages, conversationID);
      const target = records.find((record) => sameID(record.message?.id, messageID));
      if (!target) return null;
      await writeRecords(database, STORES.messages, [], [target.key]);
      if (target.message?.file?.id != null) {
        await writeRecords(database, STORES.files, [], [recordKey(scope, "file", target.message.file.id)]);
      }
      return target.message;
    }, null),

    getFilePayload: safe(async (fileID) => {
      const record = await readRecord(database, STORES.files, recordKey(scope, "file", fileID));
      return record?.payload || null;
    }, null),

    saveFilePayload: safe(async (fileID, payload) => {
      const key = recordKey(scope, "file", fileID);
      const existing = await readRecord(database, STORES.files, key);
      return writeRecords(database, STORES.files, [{ key, scope, file_id: fileID, payload, preview: existing?.preview || null }]);
    }, false),

    getFilePreview: safe(async (fileID) => {
      const record = await readRecord(database, STORES.files, recordKey(scope, "file", fileID));
      return record?.preview || null;
    }, null),

    saveFilePreview: safe(async (fileID, preview) => {
      const key = recordKey(scope, "file", fileID);
      const existing = await readRecord(database, STORES.files, key);
      return writeRecords(database, STORES.files, [{ key, scope, file_id: fileID, payload: existing?.payload || null, preview }]);
    }, false),

    deleteConversation: safe(async (conversationID) => {
      const messages = await getConversationRecords(STORES.messages, conversationID);
      const members = await getConversationRecords(STORES.members, conversationID);
      await writeRecords(database, STORES.messages, [], messages.map((record) => record.key));
      await writeRecords(database, STORES.members, [], members.map((record) => record.key));
      const fileKeys = messages
        .map((record) => record.message?.file?.id)
        .filter((fileID) => fileID != null)
        .map((fileID) => recordKey(scope, "file", fileID));
      if (fileKeys.length) await writeRecords(database, STORES.files, [], fileKeys);
      await writeRecords(database, STORES.conversations, [], [recordKey(scope, "conversation", conversationID)]);
      return true;
    }, false),

    clear: safe(async () => {
      await deleteByScope(database, STORES.conversations, scope);
      await deleteByScope(database, STORES.members, scope);
      await deleteByScope(database, STORES.messages, scope);
      await deleteByScope(database, STORES.files, scope);
      return true;
    }, false),
  };

  return cache;
}
