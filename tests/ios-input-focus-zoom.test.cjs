const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const mobile = css.slice(
  css.indexOf("@media (max-width: 720px)"),
  css.indexOf("@media (max-width: 380px)"),
);
const viewport = html.match(/<meta name="viewport" content="([^"]+)">/)?.[1] || "";

assert.match(mobile, /input, textarea, select\s*\{\s*font-size:\s*16px !important;/);
assert.match(viewport, /width=device-width/);
assert.doesNotMatch(viewport, /maximum-scale|user-scalable/);

console.log("iOS input focus: mobile controls stay at 16px without disabling pinch zoom");
