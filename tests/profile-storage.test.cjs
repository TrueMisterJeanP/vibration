const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const i18n = fs.readFileSync(path.join(root, "web/js/i18n.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");

assert.match(html, /id="profile-storage-progress"[^>]*max="1"[^>]*value="0"/);
assert.match(html, /id="profile-storage-status"/);
assert.match(app, /async function refreshFileQuotas\(\)[\s\S]*api\("\/api\/files\/limits"\)/);
assert.match(app, /function updateProfileStorage\(\)[\s\S]*profile-storage-progress/);
assert.match(app, /progress\.classList\.toggle\("near-limit", percent >= 80/);
assert.match(app, /progress\.classList\.toggle\("at-limit", percent >= 100/);
assert.match(app, /await Promise\.all\(\[[\s\S]*refreshFileQuotas\(\)/);
assert.match(i18n, /\["Stockage des fichiers", "File storage"/);
assert.match(i18n, /\["\{used\} utilisés sur \{max\} \(\{percent\} %\)",/);
assert.match(css, /\.profile-storage progress\s*\{/);
assert.match(css, /\.profile-storage progress\.at-limit/);

console.log("Profile storage: quota meter and live usage wiring verified");
