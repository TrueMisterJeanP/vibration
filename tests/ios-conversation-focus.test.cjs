const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");

const focusLifecycle = app.slice(
  app.indexOf("function isMobileConversationLayout"),
  app.indexOf("async function selectConversation"),
);
const selectConversation = app.slice(
  app.indexOf("async function selectConversation"),
  app.indexOf("function canSignalCall"),
);
const setSidebarOpen = app.slice(
  app.indexOf("const setSidebarOpen ="),
  app.indexOf("const mobileLayout =", app.indexOf("const setSidebarOpen =")),
);

assert.match(
  focusLifecycle,
  /function isMobileConversationLayout\(\) \{\s*return window\.matchMedia\("\(max-width: 720px\)"\)\.matches;\s*\}/,
);
assert.match(
  focusLifecycle,
  /function blurComposerBeforeMobileConversationTransition\(\) \{\s*if \(isMobileConversationLayout\(\) && document\.activeElement === elements\.input\) \{\s*elements\.input\.blur\(\);/,
);
assert.match(
  focusLifecycle,
  /function focusComposerAfterConversationSelection\(\) \{[\s\S]*?if \(isMobileConversationLayout\(\)\) return;\s*elements\.input\.focus\(\{ preventScroll: true \}\);/,
);
assert.ok(
  setSidebarOpen.indexOf("blurComposerBeforeMobileConversationTransition();")
    < setSidebarOpen.indexOf('elements.shell.classList.toggle("sidebar-open", open)'),
  "the composer must lose mobile focus before the panel starts moving",
);
assert.ok(
  selectConversation.indexOf("blurComposerBeforeMobileConversationTransition();")
    < selectConversation.indexOf('elements.shell.classList.remove("sidebar-open")'),
  "conversation selection must clear stale mobile focus before the chat transition",
);
assert.ok(
  selectConversation.indexOf('elements.shell.classList.remove("sidebar-open")')
    < selectConversation.indexOf("focusComposerAfterConversationSelection();"),
);
assert.doesNotMatch(
  selectConversation,
  /elements\.input\.focus\(/,
  "conversation selection must not focus the transformed mobile panel directly",
);

console.log("iOS conversation focus: mobile panel transitions cannot retain or create composer focus");
