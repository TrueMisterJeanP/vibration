const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const ui = fs.readFileSync(path.join(root, "web/js/ui.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const i18n = fs.readFileSync(path.join(root, "web/js/i18n.js"), "utf8");

assert.match(app, /async function toggleConversationFavorite\(conversation, button\)/);
assert.match(app, /\/api\/conversations\/\$\{conversation\.id\}\/favorite/);
assert.match(app, /method: "PATCH"/);
assert.match(app, /body: \{ favorite \}/);
assert.match(app, /button\.setAttribute\("aria-busy", "true"\)/);
assert.match(app, /button\.removeAttribute\("aria-busy"\)/);
assert.match(app, /favoriteIndicator\.textContent = "★"/);
assert.match(app, /actionIcon\("favorite"\)/);
assert.match(app, /bindSwipeActions\(button, row, canEdit \? 168 : 112\)/);
assert.match(ui, /favorite: \[/);
assert.match(css, /\.swipe-favorite\s*\{/);
assert.match(css, /\.favorite-indicator\s*\{/);
assert.match(i18n, /\["Ajouter aux favoris"/);
assert.match(i18n, /\["Retirer des favoris"/);

console.log("Conversation favorites: toggle, indicator and swipe action wiring verified");
