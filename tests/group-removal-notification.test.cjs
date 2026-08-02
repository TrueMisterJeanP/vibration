const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const notifications = fs.readFileSync(path.join(__dirname, "../web/js/notifications.js"), "utf8");

assert.match(app, /if \(event\.removal_notice\)[\s\S]*showGroupRemovalNotification[\s\S]*toast\(body\)/);
assert.match(notifications, /export async function showGroupRemovalNotification/);
assert.match(notifications, /tag: `group-removal-\$\{conversationID\}`/);

console.log("Group removal: realtime toast and local notification wired");
