const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const ui = fs.readFileSync(path.join(__dirname, "../web/js/ui.js"), "utf8");
const office = fs.readFileSync(path.join(__dirname, "../web/js/office-preview.js"), "utf8");

const selectConversation = source.slice(
  source.indexOf("async function selectConversation"),
  source.indexOf("function canSignalCall"),
);
const loadMessages = source.slice(
  source.indexOf("async function loadMessages"),
  source.indexOf("async function decryptMessageContent"),
);

assert.match(
  selectConversation,
  /const conversationChanged = !sameID\(state\.current\?\.id, conversation\.id\);[\s\S]*if \(conversationChanged\) \{[\s\S]*clearFileCache\(\);[\s\S]*\}[\s\S]*state\.current = conversation;/,
  "le cache des aperçus doit être vidé avant de changer de conversation",
);
assert.doesNotMatch(
  loadMessages,
  /clearFileCache\(\)/,
  "un simple rerendu des messages doit conserver le cache des aperçus",
);
assert.match(
  loadMessages,
  /clearRenderedFilePreviews\(\)/,
  "un rerendu doit détacher les anciennes ressources visuelles",
);
assert.match(
  source,
  /function clearFileCache\(\) \{[\s\S]*clearRenderedFilePreviews\(\);[\s\S]*state\.files\.clear\(\);/,
  "l’invalidation complète doit également nettoyer les ressources visuelles",
);

assert.match(ui, /preview\.textContent = "Chargement de l’aperçu…"/);
assert.match(office, /export async function preloadModernOfficePreview\(file\)/);
assert.match(loadMessages, /prefetchRecentFileThumbnails\(messages, key\)[\s\S]*prewarmFilePreviewRenderers\(decrypted\);\s*prefetchRecentFullFilePreviews\(decrypted, key\)/);
assert.match(source, /rootMargin: "1200px 0px"/);
assert.match(source, /state\.fileThumbnails\.get\(message\.file\.id\) \|\| await loadDecryptedFileThumbnail/);
assert.match(source, /image\.loading = "eager"/);
assert.match(source, /const FILE_PREVIEW_PREFETCH_BUDGET_BYTES = 8 \* 1024 \* 1024/);
assert.match(source, /function prefetchRecentFullFilePreviews\([\s\S]*limit = 4,[\s\S]*loadDecryptedFile\(message, key\)/);

console.log("File previews: cache preserved, thumbnails prefetched and renderers prewarmed");
