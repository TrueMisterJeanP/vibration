const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");

const selectConversation = app.slice(
  app.indexOf("async function selectConversation"),
  app.indexOf("function canSignalCall"),
);
const loadMessages = app.slice(
  app.indexOf("async function loadMessages"),
  app.indexOf("async function decryptMessageContent"),
);

assert.match(selectConversation, /elements\.messages\.replaceChildren\(loading\)/);
assert.match(selectConversation, /loading\.textContent = t\("Chargement…"\)/);
assert.match(loadMessages, /const conversation = state\.current;/);
assert.match(loadMessages, /const conversationID = conversation\.id;/);
assert.match(loadMessages, /if \(!sameID\(state\.current\?\.id, conversationID\)\) return;/);
assert.match(loadMessages, /getConversationKey\(conversation\)/);
assert.match(loadMessages, /messageClearCache\(conversationID\)/);

console.log("Conversation switching: previous messages cleared immediately and stale loads ignored");
