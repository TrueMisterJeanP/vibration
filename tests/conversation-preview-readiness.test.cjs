const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");

const selectConversation = app.slice(
  app.indexOf("async function selectConversation"),
  app.indexOf("function canSignalCall"),
);
const loadMessages = app.slice(
  app.indexOf("async function loadMessages"),
  app.indexOf("async function decryptMessageContent"),
);
const previewReadiness = app.slice(
  app.indexOf("function nextMessagePreviewFrame"),
  app.indexOf("function scheduleReplyFilePreview"),
);

assert.doesNotMatch(html, /message-list-preview-loading|Chargement des aperçus…/);
assert.match(css, /#message-list\.message-previews-pending\s*\{[^}]*opacity:\s*0;[^}]*pointer-events:\s*none;/);
assert.match(css, /\.message-list-transition-snapshot\s*\{[^}]*z-index:\s*2;[^}]*pointer-events:\s*none/);
assert.doesNotMatch(css, /message-list-preview-loading|message-list-preview-spinner/);

assert.match(
  selectConversation,
  /const messageLoadOptions = \{\s*waitForPreviews: conversationChanged,\s*\};/,
);
assert.doesNotMatch(
  selectConversation,
  /waitForPreviews:[^\n]*is_personal/,
  "les discussions privées et les groupes doivent partager la barrière des aperçus",
);
assert.match(
  selectConversation,
  /const startMessageLoad = \(\) => \(messagesAlreadyDisplayed[\s\S]*loadMessages\(targetMessageID, true, messageLoadOptions\)/,
);
assert.equal(
  (selectConversation.match(/startMessageLoad\(\)/g) || []).length,
  2,
  "la barrière doit être conservée avec ou sans membres déjà vérifiés",
);
// Re-cliquer sur la discussion déjà affichée ne reconstruit pas la liste.
assert.match(
  selectConversation,
  /const messagesAlreadyDisplayed = !conversationChanged && !targetMessageID\s*&& renderedConversationIsDisplayed\(selectedID\);/,
);
assert.match(
  app,
  /function renderedConversationIsDisplayed\(conversationID\)[\s\S]*elements\.messages\.dataset\.conversationId[\s\S]*querySelectorAll?\(["'`]\.message-row["'`]\)|function renderedConversationIsDisplayed\(conversationID\)[\s\S]*querySelector\("\.message-row"\)/,
);
assert.equal(
  (app.match(/elements\.messages\.dataset\.conversationId = String\(conversationID\);/g) || []).length,
  2,
  "les deux rendus de renderMessages doivent marquer la discussion affichée",
);
assert.match(
  selectConversation,
  /conversationChanged[\s\S]*transitionInProgress[\s\S]*preserveCurrentMessageList\(\);[\s\S]*beginMessagePreviewReadiness\(\);/,
);
assert.doesNotMatch(selectConversation, /loading\.textContent|Chargement des aperçus/);
assert.match(selectConversation, /if \(transitionInProgress\) elements\.messages\.replaceChildren\(\);/);
assert.match(loadMessages, /async function loadMessages\([^)]*\{ waitForPreviews = false \} = \{\}\)/);
assert.match(
  loadMessages,
  /renderMessages\(prepared\.messages, conversation, prepared\.decrypted, \{\s*waitForPreviews,\s*positionMessages: scrollToBottom,\s*\}\)/,
);
assert.match(
  loadMessages,
  /renderMessages\(messages, conversation, null, \{\s*waitForPreviews,\s*requiredPreviewMessageID: targetMessageID,\s*positionMessages: targetMessageID\s*\? \(\) => alignRenderedMessage\(targetMessageID\)\s*: \(\) => restoreMessageScrollAnchor\(anchor\),\s*\}\)/,
);

const begin = loadMessages.indexOf("beginMessagePreviewReadiness()");
const insert = loadMessages.indexOf("elements.messages.replaceChildren(fragment)", begin);
// La liste est cadrée avant le tri des aperçus : « visible » doit se mesurer
// contre la fenêtre réellement montrée, pas contre la position de départ.
const position = loadMessages.indexOf("positionMessages?.()", insert);
const prepare = loadMessages.indexOf("await prepareVisibleFilePreviews(previews, conversationID, requiredPreviewMessageID, positionMessages)", position);
const reposition = loadMessages.indexOf("positionMessages?.()", prepare);
const finish = loadMessages.indexOf("finishMessagePreviewReadiness(readinessVersion, conversationID)", reposition);
assert.ok(
  begin >= 0 && begin < insert && insert < position && position < prepare
    && prepare < reposition && reposition < finish,
);
assert.match(
  loadMessages,
  /if \(waitForPreviews \|\| requiredPreviewMessageID\) \{\s*await prepareVisibleFilePreviews\(previews, conversationID, requiredPreviewMessageID, positionMessages\)/,
);
// La préparation recadre et réévalue jusqu'à ce que la vue dévoilée n'ait plus
// d'aperçu manquant, sous une limite de passes et de temps.
assert.match(
  previewReadiness,
  /async function prepareVisibleFilePreviews\(previews, conversationID, requiredMessageID = null, positionMessages = null\)/,
);
assert.match(
  previewReadiness,
  /for \(let pass = 0; pass < MESSAGE_PREVIEW_REVEAL_PASSES && pending\.size; pass \+= 1\) \{\s*positionMessages\?\.\(\);/,
);
assert.match(previewReadiness, /if \(Date\.now\(\) >= deadline\) break;/);
assert.match(previewReadiness, /for \(const preview of pending\.values\(\)\) scheduleFilePreview\(\.\.\.preview\);/);
assert.match(app, /const MESSAGE_PREVIEW_REVEAL_PASSES = \d+;/);
assert.match(app, /const MESSAGE_PREVIEW_REVEAL_BUDGET_MS = \d+;/);
assert.doesNotMatch(loadMessages, /waitForPreviews && conversation\.is_personal/);
assert.match(loadMessages, /if \(!waitForPreviews\) \{[\s\S]*renderMessages\(cachedMessages/);
assert.match(loadMessages, /waitForPreviews && fallbackMessages[\s\S]*renderMessages\(fallbackMessages/);
assert.match(previewReadiness, /function filePreviewIsVisible\(container\)[\s\S]*getBoundingClientRect\(\)/);
assert.match(previewReadiness, /Promise\.allSettled\(batch\.map\(async \(\[message, container, key\]\)/);
assert.match(previewReadiness, /!sameID\(preview\[0\]\.id, requiredMessageID\) && !filePreviewIsVisible\(container\)/);
assert.match(previewReadiness, /await renderFilePreview\(message, container, key\);[\s\S]*await waitForFilePreviewPaint\(container\)/);

assert.match(app, /function clearMessagePreviewReadiness\([^)]*preserveSnapshot = false[^)]*\)[\s\S]*messagePreviewReadinessVersion\+\+;[\s\S]*classList\.remove\("message-previews-pending"\)/);
assert.doesNotMatch(app, /messagePreviewLoading/);
assert.match(app, /function preserveCurrentMessageList\(\)[\s\S]*while \(elements\.messages\.firstChild\) content\.append\(elements\.messages\.firstChild\)[\s\S]*snapshot\.append\(content\)/);
assert.match(app, /snapshot\.querySelectorAll\("\[id\]"\)[\s\S]*removeAttribute\("id"\)/);
assert.match(app, /function finishMessagePreviewReadiness[\s\S]*clearMessageListTransitionSnapshot\(\)[\s\S]*classList\.remove\("message-previews-pending"\)/);

console.log("Conversations: visible file previews are ready before messages are revealed");
