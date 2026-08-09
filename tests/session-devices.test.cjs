const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const loginHTML = fs.readFileSync(path.join(root, "web/login.html"), "utf8");
const linkHTML = fs.readFileSync(path.join(root, "web/link-device.html"), "utf8");
const profileHTML = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const login = fs.readFileSync(path.join(root, "web/js/login.js"), "utf8");
const link = fs.readFileSync(path.join(root, "web/js/link-device.js"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const sessions = fs.readFileSync(path.join(root, "internal/auth/device_sessions.go"), "utf8");
const authSessions = fs.readFileSync(path.join(root, "internal/auth/sessions.go"), "utf8");
const trustedDevices = fs.readFileSync(path.join(root, "internal/auth/trusted_devices.go"), "utf8");
const deviceVault = fs.readFileSync(path.join(root, "web/js/device-vault.js"), "utf8");
const vault = fs.readFileSync(path.join(root, "web/js/device-vault.js"), "utf8");
const migrations = fs.readFileSync(path.join(root, "internal/db/migrations.go"), "utf8");
const server = fs.readFileSync(path.join(root, "cmd/server/main.go"), "utf8");

assert.match(migrations, /device_name TEXT NOT NULL/);
assert.match(migrations, /last_seen_at TEXT NOT NULL/);
assert.match(migrations, /approved_at TEXT/);
assert.match(migrations, /approval_token_hash TEXT/);
assert.match(migrations, /approval_code_hash TEXT/);
assert.doesNotMatch(migrations, /approval_token TEXT|approval_code TEXT/);

assert.match(authSessions, /if trust\.ApprovalRequired \{[\s\S]*approvalTokenHash = sessionApprovalHash[\s\S]*approvalCodeHash = sessionApprovalHash/);
assert.match(authSessions, /if !approvedAt\.Valid \{[\s\S]*session approval required/);
assert.match(sessions, /const sessionApprovalDuration = 5 \* time\.Minute/);
assert.match(sessions, /sha256\.Sum256\(\[\]byte\(value\)\)/);
assert.match(sessions, /qrcode\.Encode\(value, qrcode\.Medium, 320\)/);
assert.doesNotMatch(`${login}\n${link}`, /qrserver|googleapis|chart\.google|quickchart/i);
assert.match(sessions, /approval_token_hash=NULL,approval_code_hash=NULL,approval_expires_at=NULL/);
assert.match(sessions, /func sessionReference\(sessionID string\)[\s\S]*sha256\.Sum256/);
assert.match(sessions, /item\.ID = sessionReference\(rawID\)/);
assert.match(sessions, /KickUser\(UserID\(r\), map\[string\]any\{"type": "sessions_changed"\}\)/);

for (const route of [
  "GET /api/session/status",
  "DELETE /api/session/pending",
  "GET /api/me/sessions",
  "POST /api/me/sessions/preview",
  "POST /api/me/sessions/approve",
  "DELETE /api/me/sessions/{id}",
  "POST /api/session/device-proof",
  "GET /api/me/trusted-devices",
  "POST /api/me/trusted-devices/enroll",
  "DELETE /api/me/trusted-devices/{id}",
]) assert.match(server, new RegExp(route.replace(/[{}]/g, "\\$&")));

assert.match(loginHTML, /id="session-approval-qr"/);
assert.match(loginHTML, /id="session-approval-code"/);
assert.match(login, /result\.approval_required/);
assert.match(login, /api\("\/api\/session\/status"\)/);
assert.match(login, /sessionApprovalPoll = window\.setTimeout/);
assert.match(login, /device_name:[\s\S]*device_type:/);
assert.match(login, /signTrustedDeviceChallenge[\s\S]*\/api\/session\/device-proof/);
assert.match(login, /async function optionalTrustedDeviceCredential\(\)[\s\S]*return \{\};/);
assert.match(login, /recordSuccessfulLogin\(user\.id\)[\s\S]*console\.warn/);
assert.match(vault, /generateKey\([\s\S]*ECDSA[\s\S]*namedCurve: "P-256"/);
assert.match(vault, /importKey\([\s\S]*false,[\s\S]*\["sign"\]/);
assert.match(trustedDevices, /messageauth\.VerifyRaw/);
assert.match(trustedDevices, /DELETE FROM sessions WHERE user_id=\? AND trusted_device_id=\?/);
assert.match(deviceVault, /x: jwk\.x, y: jwk\.y/);
assert.doesNotMatch(deviceVault, /y: jw\.y/);

assert.match(linkHTML, /id="link-device-approve"/);
assert.match(link, /new URLSearchParams\(location\.hash\.slice\(1\)\)/);
assert.match(link, /history\.replaceState\(null, "", `\$\{location\.pathname\}\$\{location\.search\}`\)/);
assert.match(link, /api\("\/api\/me\/sessions\/preview"/);
assert.match(link, /api\("\/api\/me\/sessions\/approve"/);

assert.match(profileHTML, /id="profile-sessions-title">Appareils et sessions/);
assert.match(profileHTML, /id="profile-session-code"/);
assert.match(profileHTML, /id="profile-session-list"/);
assert.match(profileHTML, /id="profile-trusted-device-list"/);
assert.match(app, /async function loadTrustedDevices\(\)[\s\S]*\/api\/me\/trusted-devices/);
assert.match(app, /async function revokeTrustedDevice[\s\S]*method: "DELETE"/);
assert.match(app, /async function loadDeviceSessions\(\)[\s\S]*api\("\/api\/me\/sessions"\)/);
assert.match(app, /async function approveDeviceSessionCode[\s\S]*sessions\/preview[\s\S]*sessions\/approve/);
assert.match(app, /async function revokeDeviceSession[\s\S]*method: "DELETE"/);
assert.match(app, /event\.type === "session_approval_requested"/);
assert.match(app, /event\.type === "sessions_changed"[\s\S]*clearSessionToken/);

console.log("Device sessions: QR/code approval, hashed one-use secrets, profile inventory and revocation verified");
