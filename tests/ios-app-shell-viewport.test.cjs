const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");

assert.match(html, /<html lang="fr" class="chat-app-page">/);

const viewportRule = css.match(/html\.chat-app-page,\s*html\.chat-app-page body\s*\{([^}]*)\}/)?.[1] || "";
assert.match(viewportRule, /width:\s*100%/);
assert.match(viewportRule, /height:\s*100%/);
assert.match(viewportRule, /overflow:\s*hidden/);
assert.match(viewportRule, /overscroll-behavior:\s*none/);

const bodyRule = [...css.matchAll(/html\.chat-app-page body\s*\{([^}]*)\}/g)]
  .map((match) => match[1])
  .find((rule) => /position:\s*fixed/.test(rule)) || "";
assert.match(bodyRule, /position:\s*fixed/);
assert.match(bodyRule, /inset:\s*0/);
assert.match(bodyRule, /min-height:\s*0/);
assert.match(bodyRule, /height:\s*100dvh/);

const shellRule = css.match(/html\.chat-app-page #app-shell\s*\{([^}]*)\}/)?.[1] || "";
assert.match(shellRule, /width:\s*100%/);
assert.match(shellRule, /height:\s*100%/);
assert.match(shellRule, /max-height:\s*100%/);

assert.match(
  css,
  /#chat-panel\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto auto auto;/,
  "the header and composer must remain grid tracks outside the message scroller",
);
assert.match(
  css,
  /#message-list,\s*\.message-list-transition-snapshot\s*\{[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior-y:\s*contain;/,
  "only the message viewport should own vertical scrolling",
);

console.log("iOS app viewport: document rubber-banding is locked while messages remain scrollable");
