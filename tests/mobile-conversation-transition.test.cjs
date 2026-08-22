const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "../web/css/style.css"), "utf8");
const mobile = css.slice(
  css.indexOf("@media (max-width: 720px)"),
  css.indexOf("@media (max-width: 380px)"),
);

assert.match(mobile, /#sidebar\s*\{[\s\S]*?z-index:\s*1;[\s\S]*?transform:\s*translateX\(-24%\)/);
assert.match(mobile, /#chat-panel\s*\{[\s\S]*?z-index:\s*2;[\s\S]*?transform:\s*translateX\(0\)/);
assert.match(mobile, /#app-shell\.sidebar-open #sidebar\s*\{\s*transform:\s*translateX\(0\)/);
assert.match(mobile, /#app-shell\.sidebar-open #chat-panel\s*\{[\s\S]*?transform:\s*translateX\(100%\)/);
assert.match(mobile, /transition:\s*transform \.28s cubic-bezier\(\.32, \.72, 0, 1\)/);
assert.match(css, /#chat-panel\s*\{[^}]*background-color:\s*#071b24/);
assert.match(css, /:root\[data-theme="light"\] #chat-panel\s*\{[^}]*background-color:\s*#f2f8f8/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?#sidebar,[\s\S]*?#chat-panel\s*\{\s*transition:\s*none/);

console.log("Mobile conversation transition: opaque chat slides in from the right and respects reduced motion");
