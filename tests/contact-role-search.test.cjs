const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const users = fs.readFileSync(path.join(root, "internal/users/handlers.go"), "utf8");

assert.match(html.match(/<input id="contact-search"[^>]*>/)?.[0] || "", /placeholder="Contact, rôle, code privé"/);
assert.match(html, /Nom d’utilisateur, nom affiché, rôle ou code privé[\s\S]*id="contact-search"/);
assert.match(app, /function contactDirectoryRole\(query\)/);
assert.match(app, /role: "administrator", labels: \["administrateur", "administrateurs", t\("Administrateur"\), t\("Administrateurs"\)\]/);
assert.match(app, /role: "manager", labels: \["gestionnaire", "gestionnaires", t\("Gestionnaire"\), t\("Gestionnaires"\)\]/);
assert.match(app, /async function searchContacts\(event\)[\s\S]*contactDirectoryRole\(query\)[\s\S]*searchInstanceUsers\(query, directoryRole\)/);
assert.match(app, /const searchVersion = \+\+contactSearchVersion[\s\S]*searchVersion !== contactSearchVersion[\s\S]*input\.value\.trim\(\) !== query/);
assert.match(app, /const availableUsers = directoryRole \? users : users\.filter/);
assert.match(app, /body: role \? \{ query, role \} : \{ query \}/);
assert.match(app, /contact-role-badge[\s\S]*Administrateur[\s\S]*Gestionnaire/);
assert.match(app, /const isSelf = sameID\(user\.id, state\.me\.id\)[\s\S]*const isExistingContact = acceptedContact\(user\)[\s\S]*row\.disabled = isSelf[\s\S]*isSelf \? t\("Vous"\) : isExistingContact \? t\("Ouvrir"\) : t\("Ajouter"\)/);

assert.match(users, /case "administrator":[\s\S]*u\.is_admin=1[\s\S]*case "manager":[\s\S]*u\.is_manager=1/);
assert.match(users, /case "administrateur", "administrateurs"[\s\S]*role = "administrator"[\s\S]*case "gestionnaire", "gestionnaires"[\s\S]*role = "manager"/);
assert.match(users, /roleColumn[\s\S]*u\.is_banned=0[\s\S]*u\.id=\? OR u\.is_discoverable=1[\s\S]*ORDER BY u\.username/);
assert.match(users, /LOWER\(u\.username\) LIKE \? OR LOWER\(u\.display_name\) LIKE \?/);

console.log("Contact role search: administrators and managers are discoverable without bypassing profile privacy");
