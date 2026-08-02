const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const renderConversations = app.slice(
  app.indexOf("async function renderConversations"),
  app.indexOf("function renderGroupInvitation"),
);
const refreshAll = app.slice(
  app.indexOf("async function refreshAll"),
  app.indexOf("async function refreshConversationList"),
);

assert.match(app, /let conversationRenderVersion = 0;/);
assert.match(app, /let appReady = false;/);
assert.match(app, /await renderConversations\(\{ freshMembers: true \}\);/);
assert.ok(
  refreshAll.indexOf("await renderConversations();") < refreshAll.indexOf("Promise.all"),
  "refreshAll renders cached conversations before the initial network load",
);
assert.ok(
  refreshAll.indexOf("Promise.all") < refreshAll.indexOf("await renderConversations({ freshMembers: true })"),
  "refreshAll replaces the cached list after the network load",
);
assert.match(renderConversations, /const renderVersion = \+\+conversationRenderVersion;/);
assert.match(renderConversations, /const list = document\.createDocumentFragment\(\);/);
assert.match(renderConversations, /const displays = await Promise\.all\(listedConversations\.map/);
assert.match(renderConversations, /resolveConversationDisplay\(conversation, \{ freshMembers \}\)/);
assert.match(renderConversations, /title\.textContent = display\?\.title/);
assert.doesNotMatch(renderConversations, /Conversation privée|Groupe chiffré|Conversation verrouillée/);
assert.doesNotMatch(renderConversations, /subtitle\.textContent = t\(conversation\.type ===/);
assert.match(renderConversations, /if \(renderKey === conversationListRenderKey\) return;/);
assert.doesNotMatch(renderConversations, /\btitle\.textContent = t\(conversation\.type ===/);
assert.doesNotMatch(renderConversations, /elements\.conversations\.append\(/);
assert.match(renderConversations, /elements\.conversations\.replaceChildren\(list\);/);
assert.match(renderConversations, /if \(!isCurrentRender\(\)\) return;/);

console.log("Conversation list rendering: concurrent startup renders cannot duplicate the list");
