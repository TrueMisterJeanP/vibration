const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");

const sendMessage = app.slice(
  app.indexOf("async function sendMessage"),
  app.indexOf("async function sendEncryptedText"),
);
const stageFiles = app.slice(
  app.indexOf("function stageFiles"),
  app.indexOf("function renderPendingFiles"),
);
const renderPendingFiles = app.slice(
  app.indexOf("function renderPendingFiles"),
  app.indexOf("const FILE_PREVIEW_MAX_BYTES"),
);
const selectConversation = app.slice(
  app.indexOf("async function selectConversation"),
  app.indexOf("function canSignalCall"),
);

assert.match(html, /id="file-draft"[^>]*hidden/);
assert.match(html, /id="file-draft-list"/);
assert.match(html, /id="file-draft-clear"/);
assert.match(html, /id="file-input" type="file" multiple disabled hidden/);

assert.match(app, /pendingFiles: \[\]/);
assert.match(app, /elements\.file\.addEventListener\("change", stageFiles\)/);
assert.doesNotMatch(stageFiles, /sendEncryptedFile\(/, "choosing a file must never send it immediately");
assert.match(stageFiles, /state\.pendingFiles\.push\(file\)/);
assert.match(stageFiles, /renderPendingFiles\(\)/);
assert.match(renderPendingFiles, /state\.pendingFiles\.splice\(index, 1\)/);
assert.match(renderPendingFiles, /function clearPendingFiles\(\)/);

assert.match(sendMessage, /const pendingFiles = \[\.\.\.state\.pendingFiles\]/);
assert.match(sendMessage, /if \(!conversation \|\| \(!text && !pendingFiles\.length && !pendingVoiceFile\)\) return/);
assert.match(sendMessage, /if \(text\) \{[\s\S]*sendEncryptedText\(text, conversation, replyTo\)/);
assert.match(sendMessage, /for \(const file of pendingFiles\) \{[\s\S]*sendEncryptedFile\(file, "", conversation\)/);
assert.match(sendMessage, /failedFiles\.length[\s\S]*state\.pendingFiles\.push/);
assert.match(selectConversation, /if \(conversationChanged\) \{[\s\S]*clearPendingFiles\(\)/);

assert.match(css, /\.file-draft-list\s*\{[^}]*grid-template-columns:[^}]*max-height:[^}]*overflow-y:\s*auto/);
assert.match(css, /\.file-draft-item\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);

console.log("Composer attachments: files stay removable and accumulate until explicit submission");
