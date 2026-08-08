const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");

const selectConversation = app.slice(
  app.indexOf("async function selectConversation"),
  app.indexOf("function canSignalCall"),
);
const loadMessages = app.slice(
  app.indexOf("async function loadMessages"),
  app.indexOf("async function decryptMessageContent"),
);
const mobileSelection = app.slice(
  app.indexOf("function keepConversationSelectedDuringMobileTransition"),
  app.indexOf("async function renderPersonalConversation"),
);

assert.match(selectConversation, /elements\.messages\.replaceChildren\(loading\)/);
assert.match(selectConversation, /loading\.textContent = t\("Chargement…"\)/);
assert.match(loadMessages, /const conversation = state\.current;/);
assert.match(loadMessages, /const conversationID = conversation\.id;/);
assert.match(loadMessages, /if \(!sameID\(state\.current\?\.id, conversationID\)\) return;/);
assert.match(loadMessages, /getMessageKey\(message, conversation\)/);
assert.match(loadMessages, /messageClearCache\(conversationID\)/);
assert.match(loadMessages, /renderMessages\(prepared\.messages, conversation, prepared\.decrypted\);[\s\S]*scrollMessagesToLatest\(conversationID\)/);
assert.match(loadMessages, /renderMessages\(cachedMessages, conversation\);[\s\S]*scrollMessagesToLatest\(conversationID\)/);
assert.match(selectConversation, /if \(targetMessageID\) \{[\s\S]*revealMessage\(targetMessageID\)[\s\S]*\} else \{[\s\S]*scrollMessagesToLatest\(selectedID\)/);
assert.match(app, /async function scrollMessagesToLatest\(conversationID\) \{[\s\S]*scrollToBottom\(\);[\s\S]*requestAnimationFrame\(resolve\)[\s\S]*scrollToBottom\(\);/);
assert.match(mobileSelection, /max-width: 720px/);
assert.match(mobileSelection, /querySelectorAll\("\.conversation-item\.active"\)[\s\S]*button\.classList\.add\("active"\)/);
assert.match(app, /button\.onclick = \(\) => \{\s*keepConversationSelectedDuringMobileTransition\(button\);\s*selectConversation\(conversation\)/);
assert.match(css, /\.conversation-item\s*\{[^}]*-webkit-tap-highlight-color:\s*transparent/);

console.log("Conversation switching: selected mobile row persists while messages load and stale loads are ignored");
