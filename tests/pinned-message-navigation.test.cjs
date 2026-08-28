const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const start = app.indexOf("async function showPinnedMessage");
const end = app.indexOf("async function loadPinnedMessages", start);
const source = app.slice(start, end);

assert.ok(start >= 0 && end > start);
assert.match(source, /await setPinnedPanelOpen\(false\)/);
assert.match(source, /if \(renderedMessageRow\(messageID\)\)/);
// Un aperçu resté différé doit être produit avant de rejoindre le message.
assert.match(source, /await ensureRenderedMessageFilePreview\(messageID\);\s*await setPinnedPanelOpen\(false\)/);
assert.match(app, /function scheduleFilePreview[\s\S]*state\.pendingFilePreviews\.set\(String\(message\.id\), \{ message, container, key, observer \}\)/);
assert.match(app, /async function ensureRenderedMessageFilePreview\(messageID\)[\s\S]*trackedFilePreviewRender\(pending\.message, pending\.container, pending\.key\)/);
assert.match(app, /function clearRenderedFilePreviews\(\)[\s\S]*state\.pendingFilePreviews\.clear\(\);\s*state\.filePreviewRenders\.clear\(\)/);
// Un rendu déjà en cours est partagé au lieu d'être relancé.
assert.match(app, /function trackedFilePreviewRender\(message, container, key\)[\s\S]*const running = state\.filePreviewRenders\.get\(id\);\s*if \(running\) return running;/);
assert.match(app, /async function ensureRenderedMessageFilePreview[\s\S]*const running = state\.filePreviewRenders\.get\(id\);\s*if \(running\) \{\s*await running/);

// Le panneau précharge les aperçus épinglés : « Afficher » n'a plus rien à
// télécharger ni à déchiffrer.
const pinnedPanelStart = app.indexOf("async function loadPinnedMessages");
const pinnedPanelEnd = app.indexOf("function prefetchPinnedFilePreviews", pinnedPanelStart);
const pinnedPanelSource = app.slice(pinnedPanelStart, pinnedPanelEnd);
assert.ok(pinnedPanelStart >= 0 && pinnedPanelEnd > pinnedPanelStart);
assert.match(pinnedPanelSource, /prefetchPinnedFilePreviews\(decrypted\)/);
assert.ok(
  pinnedPanelSource.indexOf("elements.pinnedMessages.replaceChildren(fragment)")
    < pinnedPanelSource.indexOf("prefetchPinnedFilePreviews(decrypted)"),
);
const prefetchStart = app.indexOf("function prefetchPinnedFilePreviews");
const prefetchEnd = app.indexOf("function pinnedMessagePreview", prefetchStart);
const prefetchSource = app.slice(prefetchStart, prefetchEnd);
assert.ok(prefetchStart >= 0 && prefetchEnd > prefetchStart);
assert.match(prefetchSource, /ensureRenderedMessageFilePreview\(message\.id\)/);
assert.match(prefetchSource, /loadDecryptedFileThumbnail\(message, key\)/);
assert.match(prefetchSource, /loadDecryptedFile\(message, key\)/);
// Le préchargement reste borné en nombre et en octets.
assert.match(prefetchSource, /remainingBytes = FILE_PREVIEW_PREFETCH_BUDGET_BYTES/);
assert.match(prefetchSource, /scheduled >= PINNED_PREVIEW_PREFETCH_LIMIT \|\| remainingBytes <= 0/);
assert.match(prefetchSource, /size <= 0 \|\| size > remainingBytes/);
assert.match(source, /await loadMessages\(messageID, true, \{ waitForPreviews: true \}\)/);
assert.match(source, /holdMessageListDuringTargetedReload\(\)/);
assert.match(app, /function holdMessageListDuringTargetedReload\(\)[\s\S]*preserveCurrentMessageList\(\)/);
assert.match(app, /function renderedMessageRow\(messageID\)/);
assert.match(app, /function alignRenderedMessage\(messageID\)[\s\S]*scrollIntoView/);
assert.doesNotMatch(source, /matchMedia/);

// Le message épinglé apparaît en place : aucun surlignage, et aucun
// défilement animé ni différé entre la fermeture du panneau et le cadrage.
assert.doesNotMatch(source, /revealMessage/);
assert.doesNotMatch(source, /navigation-target/);
assert.doesNotMatch(source, /behavior: "smooth"/);
assert.doesNotMatch(source, /setTimeout/);
assert.ok(source.indexOf("setPinnedPanelOpen(false)") < source.indexOf("loadMessages(messageID"));
assert.ok(source.indexOf("ensureRenderedMessageFilePreview") < source.indexOf("loadMessages(messageID"));
assert.ok(source.indexOf("loadMessages(messageID") < source.indexOf("alignRenderedMessage(messageID)"));
// Le cadrage suit immédiatement la remesure, sans rendre la main : la
// fermeture du panneau et l'arrivée sur la cible sont peintes ensemble.
assert.match(source, /resizeRenderedImagePreviews\(\);\s*if \(!alignRenderedMessage\(messageID\)\)/);
assert.match(app, /function alignRenderedMessage[\s\S]*behavior: "auto"/);

// Le rechargement ciblé se recentre avant que la liste ne redevienne visible.
const renderStart = app.indexOf("async function renderMessages(");
const renderEnd = app.indexOf("async function decryptMessageContent", renderStart);
const renderSource = app.slice(renderStart, renderEnd);
assert.ok(renderStart >= 0 && renderEnd > renderStart);
assert.ok(
  renderSource.indexOf("positionMessages?.()")
    < renderSource.indexOf("await prepareVisibleFilePreviews("),
);
assert.ok(
  renderSource.lastIndexOf("positionMessages?.()")
    < renderSource.lastIndexOf("finishMessagePreviewReadiness(readinessVersion, conversationID)"),
);
assert.match(app, /positionMessages: targetMessageID\s*\? \(\) => alignRenderedMessage\(targetMessageID\)/);

// Le badge « Épinglé » doit rester lisible sur les bulles claires et sombres.
assert.match(css, /\.message-pin-badge \{[^}]*color: #ffd489;[^}]*\}/);
assert.match(css, /:root\[data-theme="light"\] \.message-pin-badge \{[^}]*color: #8a5200;[^}]*\}/);
assert.match(css, /\.file-preview\s*\{[^}]*contain:\s*paint;/);
assert.doesNotMatch(css, /\.file-preview\s*\{[^}]*contain:\s*layout/);
assert.doesNotMatch(app, /stabilizeAspectRatio/);
assert.match(css, /\.file-preview\.fitted-image-preview\s*\{[^}]*display:\s*block;[^}]*min-height:\s*0/);
assert.match(css, /\.file-preview\.fitted-image-preview > img\s*\{[^}]*height:\s*100%;[^}]*max-height:\s*none/);
assert.match(app, /function fittedImagePreviewSize\(width, height, availableWidth\)/);
assert.match(app, /function fitImagePreviewToAspect\(container, image\)[\s\S]*image\.naturalWidth[\s\S]*new ResizeObserver/);
assert.match(app, /function setPinnedPanelVisibility\(open\)[\s\S]*scheduleRenderedImagePreviewResize\(\)/);
assert.match(app, /cachedDisplayed && sameMessageSnapshots[\s\S]*waitForRenderedMessageFilePreview\(targetMessageID\)/);

const fittedSizeStart = app.indexOf("function fittedImagePreviewSize");
const fittedSizeEnd = app.indexOf("function resizeFittedImagePreview", fittedSizeStart);
const fittedSizeContext = {};
vm.createContext(fittedSizeContext);
vm.runInContext(`${app.slice(fittedSizeStart, fittedSizeEnd)}\nglobalThis.fittedImagePreviewSize = fittedImagePreviewSize;`, fittedSizeContext);
assert.equal(JSON.stringify(fittedSizeContext.fittedImagePreviewSize(4032, 3024, 392)), JSON.stringify({ width: 392, height: 294 }));
assert.equal(JSON.stringify(fittedSizeContext.fittedImagePreviewSize(4032, 3024, 900)), JSON.stringify({ width: 560, height: 420 }));

function runShowPinnedMessage({ rendered }) {
  const calls = [];
  const button = { disabled: false, isConnected: true, dataset: {}, textContent: "Afficher" };
  const context = {
    setBusy(target, busy) {
      target.disabled = busy;
      calls.push(busy ? "busy" : "ready");
    },
    async setPinnedPanelOpen(open) {
      calls.push(open ? "open-panel" : "close-panel");
    },
    async nextMessagePreviewFrame() {
      calls.push("layout-frame");
    },
    renderedMessageRow(messageID) {
      calls.push(["lookup", messageID]);
      return rendered ? { dataset: { id: messageID } } : null;
    },
    alignRenderedMessage(messageID) {
      calls.push(["align", messageID]);
      return true;
    },
    resizeRenderedImagePreviews() {
      calls.push("resize-previews");
    },
    t(text) {
      return text;
    },
    holdMessageListDuringTargetedReload() {
      calls.push("hold-list");
      return () => calls.push("restore-list");
    },
    async ensureRenderedMessageFilePreview(messageID) {
      calls.push(["ensure-preview", messageID]);
    },
    async loadMessages(messageID, useCache, options) {
      calls.push(["load", messageID, useCache, options.waitForPreviews]);
    },
    frenchErrorMessage(_error, fallback) {
      return fallback;
    },
    toast(message, kind) {
      calls.push(["toast", message, kind]);
    },
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.showPinnedMessage = showPinnedMessage;`, context);
  return context.showPinnedMessage("message-42", button).then(() => ({ calls, button }));
}

(async () => {
  // Message déjà rendu : ni rechargement, ni frame intercalée entre la
  // fermeture du panneau et le cadrage sur la cible.
  const already = await runShowPinnedMessage({ rendered: true });
  assert.deepEqual(already.calls, [
    "busy",
    ["lookup", "message-42"],
    ["ensure-preview", "message-42"],
    "close-panel",
    "resize-previews",
    ["align", "message-42"],
    "layout-frame",
    "resize-previews",
    ["align", "message-42"],
    "ready",
  ]);
  assert.equal(already.button.disabled, false);

  // Message hors de la fenêtre chargée : rechargement ciblé sous le calque de
  // transition, puis cadrage dans la foulée.
  const missing = await runShowPinnedMessage({ rendered: false });
  assert.deepEqual(missing.calls, [
    "busy",
    ["lookup", "message-42"],
    "close-panel",
    "hold-list",
    ["load", "message-42", true, true],
    "resize-previews",
    ["align", "message-42"],
    "layout-frame",
    "resize-previews",
    ["align", "message-42"],
    "ready",
  ]);
  assert.equal(missing.button.disabled, false);

  console.log("Pinned message navigation: pinned message lands in place, no reload flash, no scroll");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
