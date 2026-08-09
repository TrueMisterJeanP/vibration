const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const handler = fs.readFileSync(path.join(root, "internal/conversations/handlers.go"), "utf8");

const groupDialog = html.slice(
  html.indexOf('id="group-dialog"'),
  html.indexOf('id="group-edit-dialog"'),
);
assert.match(groupDialog, /id="group-user-search"[\s\S]*id="group-user-results"[\s\S]*id="group-members-title"[\s\S]*id="group-members-count"[\s\S]*id="group-members" class="conversation-info-member-list"/);

assert.match(app, /const groupInvitedUsers = new Map\(\)/);
assert.match(app, /#group-user-search"\)\.addEventListener\("input", debounce\(searchNewGroupMembers, 300\)\)/);
assert.match(app, /async function searchNewGroupMembers\(event\)[\s\S]*searchInstanceUsers\(query\)/);
assert.match(app, /groupInvitedUsers\.set\(user\.id, userWithDiscoveryCode\(user, query\)\)/);
assert.match(app, /const members = \[state\.me, \.\.\.invitedUsers\]/);
assert.match(app, /const count = document\.querySelector\("#group-members-count"\)[\s\S]*if \(count\) count\.textContent/);
assert.match(app, /item\.className = "conversation-info-member"/);
assert.match(app, /avatar\.className = "conversation-info-member-avatar"/);
assert.match(app, /status\.textContent = t\("Vous"\)/);
assert.match(app, /"conversation-info-member-statuses group-member-check"/);
assert.match(app, /checkbox\.checked = true/);
assert.match(app, /groupInvitedUsers\.delete\(member\.id\)/);
assert.match(css, /\.picker-row\.check input\[type="checkbox"\],[\s\S]*\.group-member-check input\[type="checkbox"\][^{]*\{[^}]*appearance:\s*auto[^}]*accent-color:\s*var\(--accent\)/);
assert.match(app, /const listedIDs = new Set\(groupInvitedUsers\.keys\(\)\)/);
assert.match(app, /groupInvitedUsers\.get\(userID\)/);
assert.match(app, /selectedMembers\.some\(\(member\) => !member\)/);

const openGroupDialog = app.slice(
  app.indexOf("async function openGroupDialog"),
  app.indexOf("async function createGroup"),
);
assert.doesNotMatch(openGroupDialog, /\/api\/contacts/);
assert.doesNotMatch(openGroupDialog, /\/api\/conversations/);
assert.match(app, /const selectedMembers = selectedIDs\.map\(\(userID\) => groupInvitedUsers\.get\(userID\)\)/);

const createGroupHandler = handler.slice(
  handler.indexOf("func (h *Handler) CreateGroup"),
  handler.indexOf("func (h *Handler) createConversation"),
);
assert.doesNotMatch(createGroupHandler, /hasAcceptedContact/);
assert.match(createGroupHandler, /SELECT is_remote FROM users WHERE id=\? AND is_banned=0/);
assert.match(fs.readFileSync(path.join(root, "internal/users/handlers.go"), "utf8"), /u\.is_remote=0 AND u\.is_banned=0 AND u\.username LIKE/);

console.log("Group creation: searchable invitations without private contacts verified");
