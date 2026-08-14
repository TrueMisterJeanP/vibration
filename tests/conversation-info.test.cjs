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
assert.match(html, /id="conversation-info-members-section"[\s\S]*id="conversation-info-members-count"[\s\S]*id="conversation-info-members"/);

assert.match(app, /async function openCurrentConversationInfo\(\)/);
assert.match(app, /members\.find\(\(member\) => member\.user_id !== state\.me\.id\)/);
assert.match(app, /peer\?\.federation_instance_url[\s\S]*conversation\.federation_instance_url[\s\S]*getInstanceURL\(\)/);
assert.match(app, /elements\.conversationInfoUsernameRow\.hidden = isGroup/);
assert.match(app, /elements\.conversationInfoAddressRow\.hidden = isGroup/);
assert.match(app, /elements\.conversationInfoFingerprintRow\.hidden = isGroup/);
assert.match(app, /function renderConversationInfoMembers\(members\)/);
assert.match(app, /elements\.conversationInfoMembersSection\.hidden = !isGroup/);
assert.match(app, /elements\.conversationInfoAvatar\.classList\.toggle\("group-conversation-avatar", isGroup\)/);
assert.match(app, /if \(isGroup\) renderConversationInfoMembers\(members\)/);
assert.match(app, /member\.role === "owner"[\s\S]*t\("Propriétaire"\)/);
assert.match(app, /member\.role === "pending"[\s\S]*t\("Invitation en attente"\)/);
assert.match(app, /sameID\(member\.user_id, state\.me\.id\)[\s\S]*t\("Vous"\)/);
assert.match(app, /markIdentityVerified\(identity, current\.record\?\.fingerprint\)/);
assert.match(app, /function conversationContactAddress\(username, instance\)/);
assert.match(app, /return `\$\{normalizedUsername\}@\$\{normalizedInstance\}`/);
assert.match(app, /conversation\.encrypted_description \? display\.description : ""/);
assert.match(app, /setConversationInfoTrigger\(conversation\)/);
assert.match(app, /elements\.chatAvatar\.onclick/);
assert.match(app, /elements\.chatIdentity\.addEventListener\("keydown"/);
assert.match(app, /const closedWithPointer = event\.detail > 0;[\s\S]*conversationInfoDialog\.close\(\);[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*document\.activeElement\.blur\(\)/);

const infoDialogLoader = app.slice(
  app.indexOf("async function openCurrentConversationInfo()"),
  app.indexOf("function renderConversationHeader"),
);
const membersLoadedAt = infoDialogLoader.indexOf("await getMembers(");
const displayLoadedAt = infoDialogLoader.indexOf("await resolveConversationDisplay(");
const trustLoadedAt = infoDialogLoader.indexOf("await getIdentityTrust(");
const dialogShownAt = infoDialogLoader.indexOf("conversationInfoDialog.showModal()");
assert.ok(membersLoadedAt >= 0 && membersLoadedAt < dialogShownAt, "members must load before the information dialog opens");
assert.ok(displayLoadedAt >= 0 && displayLoadedAt < dialogShownAt, "the contact or group display data must load before the information dialog opens");
assert.ok(trustLoadedAt >= 0 && trustLoadedAt < dialogShownAt, "contact trust data must load before the information dialog opens");
assert.ok(
  infoDialogLoader.indexOf("elements.conversationInfoDescription.textContent", displayLoadedAt) < dialogShownAt,
  "the information dialog must be populated before it opens",
);
assert.doesNotMatch(infoDialogLoader, /conversationInfoName\.textContent = t\("Chargement…"\)/);

assert.match(css, /\.conversation-info-dialog\s*\{/);
assert.match(css, /\.conversation-info-avatar\s*\{/);
assert.match(css, /\.conversation-info-details\s*\{/);
assert.match(css, /\.conversation-info-member-list\s*\{/);
assert.match(css, /\.conversation-info-member-list\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
assert.match(css, /\.conversation-info-member-avatar\s*\{/);
assert.match(css, /\.picker-list\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/);
assert.match(css, /\.identity-fingerprint\s*\{/);

console.log("Conversation info: contact/group profile dialog wiring verified");
