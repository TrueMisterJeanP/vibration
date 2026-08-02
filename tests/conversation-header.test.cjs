const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");

const avatarPosition = html.indexOf('id="chat-avatar"');
const titlePosition = html.indexOf('id="chat-title"');
const mobileButtonStart = html.indexOf('id="open-sidebar-logo"');
const mobileButtonEnd = html.indexOf("</button>", mobileButtonStart);
assert.ok(avatarPosition >= 0, "the conversation header avatar must exist");
assert.ok(avatarPosition < titlePosition, "the avatar must appear before the conversation name");
assert.match(html, /id="chat-title"[\s\S]*id="chat-description"/);
assert.match(html, /button id="close-sidebar-logo"[\s\S]*aria-controls="profile-dialog"/);
assert.match(html, /id="open-sidebar-logo"[\s\S]*header-conversation-initial/);
assert.match(html, /id="group-avatar-preview" class="profile-avatar-preview"/);
assert.doesNotMatch(
  html.slice(mobileButtonStart, mobileButtonEnd),
  /brand-mark/,
  "the mobile conversation avatar must not contain the generic person symbol",
);

assert.match(app, /function renderConversationHeader\(conversation, display\)/);
assert.match(app, /const openProfileDialog = async \(\) =>/);
assert.match(app, /document\.querySelector\("#close-sidebar-logo"\)\.onclick = openProfileDialog/);
assert.match(app, /function renderPersonalNoteIcon\(container\)/);
assert.match(app, /elements\.personalConversationButton\.querySelector\("\.personal-note-avatar svg"\)/);
assert.match(app, /elements\.chatAvatar\.classList\.toggle\("personal-note-avatar", Boolean\(conversation\.is_personal\)\)/);
assert.match(app, /if \(conversation\.is_personal\) \{\s*renderPersonalNoteIcon\(elements\.chatAvatar\)/);
assert.match(app, /function conversationAvatarFallback\(display, conversation = null\)/);
assert.match(
  app,
  /return \(display\?\.title \|\| \(conversation\?\.type === "group" \? "G" : "\?"\)\)\.slice\(0, 1\)\.toUpperCase\(\)/,
  "a group without an image must use the first letter of its name",
);
assert.match(app, /function renderMobileNavigationAvatar\(display = null, conversation = null\)/);
assert.match(app, /renderMobileNavigationAvatar\(display, conversation\)/);
assert.match(app, /button\.classList\.toggle\("has-conversation-avatar", Boolean\(display\)\)/);
assert.match(app, /button\.classList\.toggle\("personal-note-avatar", showPersonalNote\)/);
assert.match(app, /if \(showPersonalNote\) \{[\s\S]*renderPersonalNoteIcon\(initial\)/);
assert.match(app, /mobileLayout\.addEventListener\("change", syncResponsiveLayout\)/);
assert.match(app, /if \(state\.current\) \{[\s\S]*refreshCurrentConversationHeader\(state\.current\.id\)/);
const mobileAvatarRenderer = app.slice(
  app.indexOf("function renderMobileNavigationAvatar"),
  app.indexOf("function replaceAvatarContent"),
);
const socketEventHandler = app.slice(
  app.indexOf("async function handleSocketEvent"),
  app.indexOf("function sendTyping"),
);
const conversationUpdatedHandler = socketEventHandler.slice(
  socketEventHandler.indexOf('event.type === "conversation_updated"'),
  socketEventHandler.indexOf('event.type === "typing"'),
);
assert.doesNotMatch(
  mobileAvatarRenderer,
  /\/icons\/(?:group|person)\.svg/,
  "the mobile header must not use generic person or group pictograms",
);
assert.match(app, /replaceAvatarContent\([\s\S]*elements\.chatAvatar,[\s\S]*display\.avatar,[\s\S]*conversationAvatarFallback\(display, conversation\)/);
assert.match(app, /replaceAvatarContent\([\s\S]*avatar,[\s\S]*display\.avatar,[\s\S]*conversationAvatarFallback\(display, conversation\),[\s\S]*\[presence\]/);
assert.match(app, /elements\.description\.textContent = display\.description/);
assert.match(app, /await refreshCurrentConversationHeader\(currentID\)/);
assert.match(
  socketEventHandler,
  /if \(event\.profile_updated\) \{\s*await getMembers\(event\.conversation_id, \{ fresh: true \}\);\s*\}/,
  "a contact profile update must refresh member data before rerendering the conversation header",
);
assert.ok(
  conversationUpdatedHandler.indexOf("await getMembers(event.conversation_id, { fresh: true })")
    < conversationUpdatedHandler.indexOf("await renderConversations()"),
  "the fresh contact profile must be available before conversations and the active header are rerendered",
);

assert.match(css, /\.chat-conversation-avatar\s*\{[^}]*background: var\(--avatar-bg\);[^}]*color: var\(--avatar-fg\);/);
assert.match(css, /\.chat-conversation-avatar img\s*\{/);
assert.match(css, /\.personal-note-avatar\s*\{[^}]*border-radius: \.75rem;[^}]*background: rgb\(32 199 181 \/ \.13\);/);
assert.match(css, /\.brand-logo-button\.has-conversation-avatar\.personal-note-avatar\s*\{/);
assert.match(css, /\.personal-note-avatar svg\s*\{/);
assert.match(css, /--avatar-bg: #1b5260;[\s\S]*--avatar-fg: #a9fff4;/);
assert.match(css, /\.brand-logo-button\.has-conversation-avatar\s*\{[^}]*background: var\(--avatar-bg\);[^}]*color: var\(--avatar-fg\);/);
assert.match(css, /\.avatar\s*\{[^}]*background: var\(--avatar-bg\);[^}]*color: var\(--avatar-fg\);/);
assert.match(css, /\.profile-avatar-preview\s*\{[^}]*background: var\(--avatar-bg\);/);
assert.match(css, /\.group-avatar-preview-icon\s*\{[^}]*stroke: currentColor;/);
assert.match(app, /function renderGroupAvatarPreview\(container, avatar\)/);
assert.match(css, /:root\[data-theme="light"\]\s*\{ --avatar-bg: #c9e7e4; --avatar-fg: #075e57; \}/);
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.chat-conversation-avatar \{ display: none; \}/);

console.log("Conversation header: avatar, name and description wiring verified");
