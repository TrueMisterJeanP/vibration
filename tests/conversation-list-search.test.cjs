const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");

const lists = html.slice(html.indexOf('id="conversation-lists"'), html.indexOf("</aside>"));
assert.match(lists, /id="conversation-search"[^>]*type="search"[^>]*placeholder="Rechercher une discussion"/);
assert.ok(lists.indexOf('id="conversation-search"') < lists.indexOf('id="personal-conversation-button"'));
assert.ok(lists.indexOf('id="personal-conversation-button"') < lists.indexOf('id="conversation-list"'));
assert.match(css, /\.conversation-search input\s*\{[^}]*border-radius:\s*\.7rem/);
assert.match(css, /\.conversation-search input\s*\{[^}]*height:\s*2\.8rem/);
assert.match(css, /\.conversation-search input::placeholder\s*\{[^}]*color:\s*rgb\(145 170 169 \/ \.72\)[^}]*font-weight:\s*400/);
assert.match(css, /\.conversation-search-hidden\s*\{[^}]*display:\s*none\s*!important/);
assert.match(css, /#conversation-lists\s*\{[^}]*--discussion-control-gap:\s*1\.2rem;[^}]*--discussion-search-bottom-space:\s*\.65rem;/);
assert.match(css, /\.actions\s*\{[^}]*padding:\s*\.45rem 1rem var\(--discussion-control-gap\);/);
assert.match(css, /\.conversation-search\s*\{[^}]*padding:\s*0 1rem var\(--discussion-search-bottom-space\);/);
assert.match(css, /\.conversation-section-heading\s*\{[^}]*margin:\s*calc\(var\(--discussion-control-gap\) - var\(--discussion-search-bottom-space\)\) 1\.35rem \.35rem;/);
assert.match(css, /\.actions #contact-button,[\s\S]*box-shadow:\s*none;/);
assert.match(css, /\.actions #group-button,[\s\S]*box-shadow:\s*none;/);
assert.match(css, /\.actions button\s*\{[^}]*height:\s*3rem;[^}]*min-height:\s*3rem;/);
assert.match(app, /conversationSearch\.addEventListener\("input", applyConversationSearch\)/);
assert.match(app, /row\.dataset\.conversationSearch = \[display\?\.title, display\?\.description, preview\]/);
assert.match(app, /elements\.personalConversationButton\.dataset\.conversationSearch/);
assert.match(app, /elements\.conversations\.replaceChildren\(list\);\s*applyConversationSearch\(\);/);

const normalizeStart = app.indexOf("function normalizedConversationSearch");
const normalizeEnd = app.indexOf("function applyConversationSearch", normalizeStart);
assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart);
const context = { locale: "fr-FR" };
vm.createContext(context);
vm.runInContext(`${app.slice(normalizeStart, normalizeEnd)}\nthis.matches = conversationMatchesSearch;`, context);
assert.equal(context.matches("Équipe d’été", "equipe"), true);
assert.equal(context.matches("Projet Alpha", "ALPHA"), true);
assert.equal(context.matches("Projet Alpha", "bêta"), false);
assert.equal(context.matches("Projet Alpha", "   "), true);

console.log("Conversation list search: local, accent-insensitive filtering verified");
