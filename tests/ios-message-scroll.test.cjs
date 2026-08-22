const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");

assert.match(
  html,
  /<div id="message-list">\s*<div id="message-list-content">/,
  "the scroll surface and the reversed message flow must use separate elements",
);

const scrollerRule = css.match(/#message-list,\s*\.message-list-transition-snapshot\s*\{([^}]*)\}/)?.[1] || "";
assert.match(scrollerRule, /overflow-y:\s*auto/);
assert.match(scrollerRule, /overscroll-behavior-y:\s*contain/);
assert.match(scrollerRule, /-webkit-overflow-scrolling:\s*touch/);
assert.doesNotMatch(scrollerRule, /display:\s*flex|flex-direction/);

const contentRule = css.match(/#message-list-content,\s*\.message-list-transition-content\s*\{([^}]*)\}/)?.[1] || "";
assert.match(contentRule, /display:\s*flex/);
assert.match(contentRule, /flex-direction:\s*column-reverse/);
assert.match(contentRule, /min-height:\s*100%/);
assert.doesNotMatch(contentRule, /overflow|padding/);

assert.match(app, /messageScroller:\s*document\.querySelector\("#message-list"\)/);
assert.match(app, /messages:\s*document\.querySelector\("#message-list-content"\)/);
assert.match(
  app,
  /function scrollToBottom\(\)\s*\{\s*elements\.messageScroller\.scrollTop = elements\.messageScroller\.scrollHeight;/,
);
assert.match(app, /root:\s*elements\.messageScroller, rootMargin:\s*"1200px 0px"/);
assert.match(
  app,
  /content\.className = "message-list-transition-content";[\s\S]*while \(elements\.messages\.firstChild\) content\.append/,
);

console.log("iOS message scrolling: the block scroller is independent from the reversed flex flow");
