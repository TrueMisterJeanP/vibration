const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const handler = fs.readFileSync(path.join(root, "internal/conversations/handlers.go"), "utf8");

const groupDialog = html.slice(
  html.indexOf('id="group-dialog"'),
  html.indexOf('id="group-edit-dialog"'),
);
assert.match(groupDialog, /id="group-user-search"[\s\S]*id="group-user-results"[\s\S]*<legend>Membres<\/legend>/);

assert.match(app, /const groupInvitedUsers = new Map\(\)/);
assert.match(app, /#group-user-search"\)\.addEventListener\("input", debounce\(searchNewGroupMembers, 300\)\)/);
assert.match(app, /async function searchNewGroupMembers\(event\)[\s\S]*\/api\/users\/search\?q=/);
assert.match(app, /groupInvitedUsers\.set\(user\.id, user\)/);
assert.match(app, /extraUsers: \[\.\.\.groupInvitedUsers\.values\(\)\]/);
assert.match(app, /groupInvitedUsers\.get\(userID\)/);
assert.match(app, /selectedMembers\.some\(\(member\) => !member\)/);

const createGroupHandler = handler.slice(
  handler.indexOf("func (h *Handler) CreateGroup"),
  handler.indexOf("func (h *Handler) createConversation"),
);
assert.doesNotMatch(createGroupHandler, /hasAcceptedContact/);
assert.match(createGroupHandler, /SELECT is_remote FROM users WHERE id=\? AND is_banned=0/);

console.log("Group creation: searchable invitations without private contacts verified");
