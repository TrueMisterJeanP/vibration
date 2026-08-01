const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const adminHTML = fs.readFileSync(path.join(__dirname, "../web/admin.html"), "utf8");
const adminJS = fs.readFileSync(path.join(__dirname, "../web/js/admin.js"), "utf8");
const loginJS = fs.readFileSync(path.join(__dirname, "../web/js/login.js"), "utf8");
const enterprise = fs.readFileSync(path.join(__dirname, "../cmd/server/edition_enterprise.go"), "utf8");
const store = fs.readFileSync(path.join(__dirname, "../internal/invitationstore/store.go"), "utf8");

assert.match(adminHTML, /data-panel="invitations"/);
assert.match(adminHTML, /contact-invitation-code/);
assert.match(adminHTML, /contact-invitation-duration/);
for (const channel of ["E-mail", "SMS", "Signal", "WhatsApp", "Autre messagerie"]) {
  assert.match(adminJS, new RegExp(channel));
}
assert.match(adminJS, /navigator\.share/);
assert.match(adminJS, /mailto:/);
assert.match(adminJS, /sms:/);
assert.match(adminJS, /wa\.me/);
assert.match(loginJS, /invitation_link/);
assert.match(enterprise, /GET \/invite\/{code}/);
assert.match(enterprise, /POST \/api\/admin\/invitations/);
assert.match(store, /codePattern/);
assert.match(store, /expires_at/);
console.log("Admin invitations: custom codes, expiry and channel sharing wired");
