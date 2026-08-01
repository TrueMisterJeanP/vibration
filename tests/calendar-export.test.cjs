const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const i18n = fs.readFileSync(path.join(root, "web/js/i18n.js"), "utf8");

assert.match(html, /id="profile-calendar-export"/);
assert.match(html, /id="profile-calendar-password"/);
assert.match(html, /id="profile-calendar-revoke"/);
assert.match(app, /async function exportCalendarICalendar\(\)[\s\S]*buildCalendarICalendar/);
assert.match(app, /async function createSharedCalendarFeed\(\)[\s\S]*api\("\/api\/calendar\/feeds"/);
assert.match(app, /async function syncSharedCalendarFeed\(\)[\s\S]*\/api\/calendar\/feeds/);
assert.match(app, /function buildCalendarICalendar\(items\)[\s\S]*SUMMARY:\$\{icalEscape\(item\.clear\.name\)\}/);
assert.match(app, /DESCRIPTION:\$\{icalEscape\(item\.clear\.description\)\}/);
assert.match(app, /LOCATION:\$\{icalEscape\(item\.clear\.location\)\}/);
assert.match(app, /await decryptMessageContent\(message, key\)/);
assert.match(i18n, /\["Exporter les évènements", "Export events"/);
assert.match(i18n, /\["Cette exportation est générée localement après déchiffrement\./);
assert.match(i18n, /\["Flux calendrier partagé", "Shared calendar feed"/);

console.log("Calendar export: locally decrypted iCalendar fields and translations verified");
