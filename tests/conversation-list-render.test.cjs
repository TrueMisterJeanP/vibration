const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../web/css/style.css"), "utf8");
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
assert.match(renderConversations, /avatar\.className = conversation\.type === "group" \? "avatar group-conversation-avatar" : "avatar"/);
assert.doesNotMatch(renderConversations, /Conversation privée|Groupe chiffré|Conversation verrouillée/);
assert.doesNotMatch(renderConversations, /subtitle\.textContent = t\(conversation\.type ===/);
assert.match(renderConversations, /if \(renderKey === conversationListRenderKey\) return;/);
assert.doesNotMatch(renderConversations, /\btitle\.textContent = t\(conversation\.type ===/);
assert.doesNotMatch(renderConversations, /elements\.conversations\.append\(/);
assert.match(renderConversations, /elements\.conversations\.replaceChildren\(list\);/);
assert.match(renderConversations, /if \(!isCurrentRender\(\)\) return;/);
assert.match(css, /\.conversation-row \.conversation-title-row\s*\{[^}]*padding-right:\s*4\.75rem;/);
assert.match(
  css,
  /\.conversation-row \.conversation-time\s*\{[^}]*position:\s*absolute;[^}]*top:\s*\.45rem;[^}]*right:\s*\.55rem;[^}]*width:\s*4\.25rem;[^}]*text-align:\s*right;/,
  "la date doit rester alignée à droite au-dessus du menu de la discussion",
);
assert.match(css, /\.personal-conversation-item > span:nth-child\(2\)\s*\{[^}]*flex:\s*1 1 auto;[^}]*max-width:\s*none;/);
assert.match(css, /\.personal-conversation-item \.conversation-title-row\s*\{[^}]*padding-right:\s*4\.75rem;/);
assert.match(
  css,
  /#personal-conversation-time\s*\{[^}]*position:\s*absolute;[^}]*top:\s*\.45rem;[^}]*right:\s*\.65rem;[^}]*width:\s*4\.25rem;[^}]*text-align:\s*right;/,
  "l’horodatage des notes personnelles doit rester aligné à droite comme les autres discussions",
);

console.log("Conversation list rendering: concurrent startup renders cannot duplicate the list");
