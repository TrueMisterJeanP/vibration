const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const preload = app.slice(
  app.indexOf("function conversationPreloadKey"),
  app.indexOf("async function refreshAll"),
);
const refreshAll = app.slice(
  app.indexOf("async function refreshAll"),
  app.indexOf("async function refreshConversationList"),
);
const selectConversation = app.slice(
  app.indexOf("async function selectConversation"),
  app.indexOf("function canSignalCall"),
);
const loadMessages = app.slice(
  app.indexOf("async function loadMessages"),
  app.indexOf("async function decryptMessageContent"),
);

assert.match(app, /const BACKGROUND_CONVERSATION_PRELOAD_LIMIT = 6;/);
assert.match(app, /const BACKGROUND_CONVERSATION_PRELOAD_CONCURRENCY = 2;/);
assert.match(app, /const BACKGROUND_THUMBNAIL_PRELOAD_CONCURRENCY = 2;/);
assert.match(app, /const BACKGROUND_THUMBNAIL_PRELOAD_BUDGET_BYTES = 4 \* 1024 \* 1024;/);
assert.match(preload, /conversation\.unread_count[\s\S]*conversation\.favorite_at[\s\S]*conversation\.last_message_at/);
assert.match(preload, /\/messages\?limit=50/);
assert.match(preload, /state\.cache\?\.putMessages\(messages\)/);
assert.match(preload, /decryptMessageContent\(message, conversationKey\)/);
assert.match(preload, /previewSize > FILE_PREVIEW_MAX_BYTES \+ 64 \|\| previewSize > session\.remainingThumbnailBytes/);
assert.match(preload, /runBackgroundTasks\(tasks, BACKGROUND_CONVERSATION_PRELOAD_CONCURRENCY\)/);

const cachedRender = refreshAll.indexOf("if (cachedConversations?.length)");
const networkLoad = refreshAll.indexOf("Promise.all");
assert.ok(cachedRender >= 0 && cachedRender < networkLoad, "la liste en cache doit être rendue avant l’attente réseau");
assert.match(refreshAll, /await renderConversations\(\);[\s\S]*Promise\.all/);
assert.match(refreshAll, /await renderConversations\(\{ freshMembers: true \}\);[\s\S]*?scheduleBackgroundConversationPreloads\(conversations\)/);

assert.ok(
  selectConversation.indexOf("const messagesLoading = loadMessages") < selectConversation.indexOf("await resolveConversationDisplay"),
  "les messages préparés doivent être rendus pendant la transition",
);
assert.match(loadMessages, /preparedConversationMessages\(conversation\)/);
assert.match(loadMessages, /renderMessages\(prepared\.messages, conversation, prepared\.decrypted\)/);
assert.match(loadMessages, /state\.conversationPreloads\.get\(conversationPreloadKey\(conversationID\)\)/);

console.log("Conversation background preload: cached list, prioritized messages and bounded thumbnails wired");
