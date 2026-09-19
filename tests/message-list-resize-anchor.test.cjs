const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");

// Le réancrage doit être branché sur le redimensionnement, sur le défilement
// de l'utilisateur et sur la remesure des aperçus d'images.
assert.match(app, /window\.addEventListener\("resize", keepMessagesAnchoredWhileResizing\)/);
assert.match(
  app,
  /elements\.messageScroller\.addEventListener\("scroll", trackMessageBottomAnchor, \{ passive: true \}\)/,
);
assert.match(
  app,
  /const observer = new ResizeObserver\(\(\) => \{[\s\S]*resizeFittedImagePreview\(container\);\s*restoreMessageBottomAnchorAfterPreviewResize\(\);/,
);

const start = app.indexOf("const MESSAGE_BOTTOM_ANCHOR_TOLERANCE");
const end = app.indexOf("async function scrollMessagesToLatest", start);
const source = app.slice(start, end);
assert.ok(start >= 0 && end > start);
assert.ok(source.includes("function keepMessagesAnchoredWhileResizing()"));
assert.ok(source.includes("function restoreMessageBottomAnchorAfterPreviewResize()"));
assert.ok(source.includes("function prepareReservedFilePreviewCommit(container)"));
assert.ok(source.includes("function commitReservedFilePreview(container, commit)"));
assert.match(
  app,
  /renderModernOfficePreview\(file, container, \{[\s\S]*beforeCommit: \(\) => prepareReservedFilePreviewCommit\(container\),[\s\S]*afterCommit: restoreReservedFilePreviewCommit/,
);
assert.match(
  app,
  /commitReservedFilePreview\(container, \(\) => \{[\s\S]*container\.replaceChildren\(image\)/,
);

function harness({ scrollHeight, clientHeight, scrollTop }) {
  const scroller = { scrollHeight, clientHeight, scrollTop };
  const timers = [];
  const context = {
    elements: { messageScroller: scroller },
    state: { current: null },
    scrollToBottom() {
      scroller.scrollTop = scroller.scrollHeight;
    },
    scrollMessagesToLatest() {},
    window: {
      clearTimeout(id) {
        const timer = timers[id - 1];
        if (timer) timer.cancelled = true;
      },
      setTimeout(callback) {
        timers.push({ callback, cancelled: false });
        return timers.length;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}
globalThis.api = {
  trackMessageBottomAnchor,
  keepMessagesAnchoredWhileResizing,
  restoreMessageBottomAnchorAfterPreviewResize,
  isAnchored: () => messagesAnchoredAtBottom,
  isResizing: () => messageResizeInProgress,
};`,
    context,
  );
  return {
    scroller,
    api: context.api,
    settle() {
      for (const timer of timers) if (!timer.cancelled) timer.callback();
    },
  };
}

// Discussion collée en bas : rétrécir la fenêtre puis remesurer les aperçus
// doit ramener le dernier message tout en bas.
const bottom = harness({ scrollHeight: 4000, clientHeight: 800, scrollTop: 3200 });
bottom.api.trackMessageBottomAnchor();
assert.equal(bottom.api.isAnchored(), true);
bottom.api.keepMessagesAnchoredWhileResizing();
assert.equal(bottom.api.isResizing(), true);
assert.equal(bottom.scroller.scrollTop, 4000);
// Un aperçu rétréci raccourcit le contenu : le défilement doit suivre.
bottom.scroller.scrollHeight = 3400;
bottom.scroller.scrollTop = 2100;
bottom.api.restoreMessageBottomAnchorAfterPreviewResize();
assert.equal(bottom.scroller.scrollTop, 3400);
bottom.settle();
assert.equal(bottom.api.isResizing(), false);
assert.equal(bottom.api.isAnchored(), true);

// Discussion volontairement remontée : le redimensionnement ne doit pas la
// ramener en bas ni écraser la position lue par l'utilisateur.
const scrolled = harness({ scrollHeight: 4000, clientHeight: 800, scrollTop: 900 });
scrolled.api.trackMessageBottomAnchor();
assert.equal(scrolled.api.isAnchored(), false);
scrolled.api.keepMessagesAnchoredWhileResizing();
assert.equal(scrolled.scroller.scrollTop, 900);
scrolled.scroller.scrollHeight = 3400;
scrolled.api.restoreMessageBottomAnchorAfterPreviewResize();
assert.equal(scrolled.scroller.scrollTop, 900);
scrolled.settle();
assert.equal(scrolled.api.isAnchored(), false);

// Les déplacements provoqués par la mise en page pendant un redimensionnement
// ne doivent pas être pris pour un défilement de l'utilisateur.
const noisy = harness({ scrollHeight: 4000, clientHeight: 800, scrollTop: 3200 });
noisy.api.trackMessageBottomAnchor();
noisy.api.keepMessagesAnchoredWhileResizing();
noisy.scroller.scrollTop = 500;
noisy.api.trackMessageBottomAnchor();
assert.equal(noisy.api.isAnchored(), true);

// Une actualisation complète (retour au premier plan, reconnexion, réaction…)
// doit rendre la liste à la position où l'utilisateur l'avait laissée.
const loadStart = app.indexOf("async function loadMessages(");
const loadEnd = app.indexOf("function updateRenderedMessageStatuses", loadStart);
const loadSource = app.slice(loadStart, loadEnd);
assert.ok(loadStart >= 0 && loadEnd > loadStart);
assert.match(loadSource, /const anchor = targetMessageID \? null : captureMessageScrollAnchor\(\);/);
// Le repère est posé avant le rendu et rejoué pendant que la liste est masquée.
assert.match(loadSource, /positionMessages: targetMessageID\s*\? \(\) => alignRenderedMessage\(targetMessageID\)\s*: \(\) => restoreMessageScrollAnchor\(anchor\),/);
assert.match(
  loadSource,
  /if \(anchor\?\.bottom && sameID\(state\.current\?\.id, conversationID\)\) \{\s*await scrollMessagesToLatest\(conversationID\);/,
);
assert.ok(
  loadSource.indexOf("captureMessageScrollAnchor()") < loadSource.indexOf("await renderMessages(messages"),
);

const anchorStart = app.indexOf("function captureMessageScrollAnchor(");
const anchorEnd = app.indexOf("async function scrollMessagesToLatest", anchorStart);
const anchorSource = app.slice(anchorStart, anchorEnd);
assert.ok(anchorStart >= 0 && anchorEnd > anchorStart);

function anchorHarness({ rows, viewportBottom, atBottom }) {
  const context = {
    elements: {
      messageScroller: {
        scrollTop: 0,
        getBoundingClientRect: () => ({ bottom: viewportBottom }),
      },
      messages: {
        hasChildNodes: () => rows.length > 0,
        querySelectorAll: () => rows,
      },
    },
    messagesAreScrolledToBottom: () => atBottom,
    renderedMessageRow: (id) => rows.find((row) => row.dataset.id === id) || null,
    scrollToBottom() {
      context.scrolledToLatest = true;
    },
    scrolledToLatest: false,
    // Le repère est rejoué à la frame suivante pour rattraper ce qui se pose
    // après l'injection : les rappels en attente sont exécutés à la demande.
    frames: [],
    requestAnimationFrame(callback) {
      context.frames.push(callback);
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${anchorSource}
globalThis.anchorApi = {
  captureMessageScrollAnchor,
  restoreMessageScrollAnchor,
  commitReservedFilePreview,
};`,
    context,
  );
  return context;
}

const makeRow = (id, top) => ({ dataset: { id }, getBoundingClientRect: () => ({ top }) });

// Collé en bas : le repère demande explicitement le bas de la discussion.
const pinned = anchorHarness({ rows: [makeRow("1", 100)], viewportBottom: 900, atBottom: true });
assert.equal(pinned.anchorApi.captureMessageScrollAnchor().bottom, true);

// Remonté : on retient le message le plus bas encore visible et son décalage.
const held = anchorHarness({
  rows: [makeRow("1", 100), makeRow("2", 400), makeRow("3", 1200)],
  viewportBottom: 900,
  atBottom: false,
});
const heldAnchor = held.anchorApi.captureMessageScrollAnchor();
assert.equal(heldAnchor.bottom, false);
assert.equal(heldAnchor.id, "2");
assert.equal(heldAnchor.offset, 500);

// Après reconstruction, le message repère revient à la même place.
const restored = anchorHarness({
  rows: [makeRow("1", 60), makeRow("2", 260), makeRow("3", 1000)],
  viewportBottom: 900,
  atBottom: false,
});
restored.anchorApi.restoreMessageScrollAnchor(heldAnchor);
assert.equal(restored.elements.messageScroller.scrollTop, -140);
assert.equal(restored.scrolledToLatest, false);

// Repère disparu (message supprimé) : repli sur le bas de la discussion.
const lost = anchorHarness({ rows: [makeRow("9", 200)], viewportBottom: 900, atBottom: false });
lost.anchorApi.restoreMessageScrollAnchor(heldAnchor);
assert.equal(lost.scrolledToLatest, true);

// Une prévisualisation chargée pendant que l'utilisateur remonte la discussion
// peut changer la géométrie de la liste. Le message visible reste néanmoins à
// la même place à l'écran au moment précis où le rendu est injecté.
let previewTop = 400;
const previewRow = {
  dataset: { id: "2" },
  getBoundingClientRect: () => ({ top: previewTop }),
};
const previewCommit = anchorHarness({ rows: [previewRow], viewportBottom: 900, atBottom: false });
const previewContainer = {
  dataset: { previewLayoutPending: "true" },
  removeAttribute(name) {
    if (name === "data-preview-layout-pending") delete this.dataset.previewLayoutPending;
  },
};
const committed = previewCommit.anchorApi.commitReservedFilePreview(previewContainer, () => {
  previewTop = 250;
  return "rendered";
});
assert.equal(committed, "rendered");
assert.equal(previewContainer.dataset.previewLayoutPending, undefined);
assert.equal(previewCommit.elements.messageScroller.scrollTop, -150);

console.log("Message list: bottom stays pinned on resize and refreshes keep their position");

// Reprendre le focus ne doit rien reconstruire tant que la fenêtre est restée
// visible et le socket ouvert : la position de lecture ne bouge pas.
const focusStart = app.indexOf("function handleAppFocus()");
const focusEnd = app.indexOf("function handleAppVisibilityChange()", focusStart);
const focusSource = app.slice(focusStart, focusEnd);
assert.ok(focusStart >= 0 && focusEnd > focusStart);
assert.match(focusSource, /if \(!document\.hidden && socketIsConnected\(\)\) return;/);
assert.ok(
  focusSource.indexOf("if (!document.hidden && socketIsConnected()) return;")
    < focusSource.indexOf("refreshConversationListOnForeground()"),
);
// Redevenir visible après un passage en arrière-plan resynchronise toujours.
const visibilityStart = app.indexOf("function handleAppVisibilityChange()");
const visibilityEnd = app.indexOf("function refreshConversationListOnForeground", visibilityStart);
const visibilitySource = app.slice(visibilityStart, visibilityEnd);
assert.ok(visibilityStart >= 0 && visibilityEnd > visibilityStart);
assert.match(visibilitySource, /refreshConversationListOnForeground\(\{ reconnectSocket: suspended \}\)/);
assert.doesNotMatch(visibilitySource, /socketIsConnected/);
// Une reconnexion du socket resynchronise aussi, c'est le filet de sécurité.
assert.match(app, /addEventListener\("status"[\s\S]*if \(state\.current\) loadMessages\(null, false\)/);

// Un nouveau message arrivé dans la discussion ouverte reste collé en bas,
// sans reconstruction de la liste.
const appendStart = app.indexOf("async function appendMessage(");
const appendEnd = app.indexOf("function pollOptionValues()", appendStart);
const appendSource = app.slice(appendStart, appendEnd);
assert.ok(appendStart >= 0 && appendEnd > appendStart);
assert.match(appendSource, /elements\.messages\.prepend\(fragment\)/);
assert.match(appendSource, /if \(scroll\) scrollToBottom\(\);/);
assert.doesNotMatch(appendSource, /replaceChildren/);

// Changer de discussion affiche le dernier message.
const selectStart = app.indexOf("async function selectConversation(");
const selectEnd = app.indexOf("function canSignalCall(", selectStart);
const selectSource = app.slice(selectStart, selectEnd);
assert.ok(selectStart >= 0 && selectEnd > selectStart);
assert.match(selectSource, /if \(targetMessageID\) \{\s*await revealMessage\(targetMessageID\);\s*\} else \{\s*await scrollMessagesToLatest\(selectedID\);/);

console.log("Focus: reading position preserved; new messages and conversation switches jump to the latest");
