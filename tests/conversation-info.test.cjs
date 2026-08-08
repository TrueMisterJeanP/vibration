const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");

assert.match(html, /id="chat-avatar"[\s\S]*aria-controls="conversation-info-dialog"/);
assert.match(html, /id="conversation-info-dialog"[\s\S]*id="conversation-info-avatar"/);
assert.match(html, /id="conversation-info-display-name"/);
assert.match(html, /id="conversation-info-username"/);
assert.match(html, /id="conversation-info-address"/);
assert.match(html, /id="conversation-info-instance"/);
assert.match(html, /id="conversation-info-description"/);
assert.match(html, /id="conversation-info-fingerprint"/);
assert.match(html, /id="conversation-info-trust-status"/);
assert.match(html, /id="conversation-info-verify"/);

assert.match(app, /async function openCurrentConversationInfo\(\)/);
assert.match(app, /members\.find\(\(member\) => member\.user_id !== state\.me\.id\)/);
assert.match(app, /peer\?\.federation_instance_url[\s\S]*conversation\.federation_instance_url[\s\S]*getInstanceURL\(\)/);
assert.match(app, /elements\.conversationInfoUsernameRow\.hidden = isGroup/);
assert.match(app, /elements\.conversationInfoAddressRow\.hidden = isGroup/);
assert.match(app, /elements\.conversationInfoFingerprintRow\.hidden = isGroup/);
assert.match(app, /markIdentityVerified\(identity, current\.record\?\.fingerprint\)/);
assert.match(app, /function conversationContactAddress\(username, instance\)/);
assert.match(app, /return `\$\{normalizedUsername\}@\$\{normalizedInstance\}`/);
assert.match(app, /conversation\.encrypted_description \? display\.description : ""/);
assert.match(app, /setConversationInfoTrigger\(conversation\)/);
assert.match(app, /elements\.chatAvatar\.onclick/);
assert.match(app, /elements\.chatIdentity\.addEventListener\("keydown"/);

assert.match(css, /\.conversation-info-dialog\s*\{/);
assert.match(css, /\.conversation-info-avatar\s*\{/);
assert.match(css, /\.conversation-info-details\s*\{/);
assert.match(css, /\.identity-fingerprint\s*\{/);

console.log("Conversation info: contact/group profile dialog wiring verified");
