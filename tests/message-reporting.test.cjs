const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const ui = fs.readFileSync(path.join(root, "web/js/ui.js"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const admin = fs.readFileSync(path.join(root, "web/js/admin.js"), "utf8");
const server = fs.readFileSync(path.join(root, "cmd/server/main.go"), "utf8");
const handlers = fs.readFileSync(path.join(root, "internal/messages/handlers.go"), "utf8");
const adminHandlers = fs.readFileSync(path.join(root, "internal/admin/handlers.go"), "utf8");
const migrations = fs.readFileSync(path.join(root, "internal/db/migrations.go"), "utf8");

const reportDialog = html.slice(html.indexOf('id="message-report-dialog"'), html.indexOf('id="action-dialog"'));
for (const reason of ["harassment", "threats", "hate", "sexual_content", "spam_scam", "personal_data", "illegal_content"]) {
  assert.match(reportDialog, new RegExp(`name="reason" value="${reason}"`));
}
assert.doesNotMatch(reportDialog, /textarea|encrypted_content/);
assert.match(reportDialog, /Le contenu chiffré ne sera pas transmis/);

assert.match(ui, /if \(!mine\) \{[\s\S]*message\.is_reported[\s\S]*Retirer le signalement[\s\S]*aria-pressed[\s\S]*onMessageReport\(message, reportButton\)/);
const reportFunction = app.slice(app.indexOf("async function reportMessage"), app.indexOf("async function loadDecryptedFile"));
assert.match(reportFunction, /api\(`\/api\/messages\/\$\{message\.id\}\/report`, \{[\s\S]*method: "POST"[\s\S]*body: \{ reason \}/);
assert.match(reportFunction, /message\.is_reported[\s\S]*method: "DELETE"[\s\S]*storeMessageReportState\(message, false, button\)/);
assert.doesNotMatch(reportFunction, /clear|encrypted_content|decrypt/);

assert.match(server, /POST \/api\/messages\/\{id\}\/report/);
assert.match(server, /DELETE \/api\/messages\/\{id\}\/report/);
assert.match(handlers, /validMessageReportReasons[\s\S]*cannot report own message[\s\S]*INSERT INTO message_reports/);
assert.match(handlers, /JOIN conversation_members cm[\s\S]*cm\.role<>'pending'/);
assert.match(handlers, /IsReported[\s\S]*own_report\.message_id IS NOT NULL/);
assert.match(handlers, /func \(h \*Handler\) Unreport[\s\S]*DELETE FROM message_reports WHERE message_id=\? AND reporter_id=\?/);

const reportTable = migrations.slice(migrations.indexOf("CREATE TABLE IF NOT EXISTS message_reports"), migrations.indexOf("CREATE TABLE IF NOT EXISTS calendar_feeds"));
assert.match(reportTable, /message_id[\s\S]*reporter_id[\s\S]*reason[\s\S]*created_at/);
assert.doesNotMatch(reportTable, /encrypted|content/);
assert.match(reportTable, /UNIQUE\(message_id, reporter_id\)/);

assert.match(adminHandlers, /report_count[\s\S]*FROM message_reports[\s\S]*ORDER BY report_count DESC/);
assert.match(adminHandlers, /ReporterUsername[\s\S]*Reason[\s\S]*CreatedAt/);
assert.match(adminHandlers, /func \(h \*Handler\) RemoveMessageReport[\s\S]*message_report_removed/);
assert.match(adminHandlers, /SendToUser\(reporterID,[\s\S]*message_report_removed[\s\S]*conversation_id[\s\S]*message_id/);
assert.match(admin, /message\.report_count[\s\S]*message\.reports[\s\S]*report\.reporter_username[\s\S]*messageReportReasonLabel[\s\S]*method: "DELETE"/);
assert.match(admin, /admin-row-actions admin-message-actions[\s\S]*actionButton\("Supprimer"[\s\S]*actionButton\("Retirer"[\s\S]*actions\.append\(remove\)/);
assert.match(app, /event\.type === "message_report_removed"[\s\S]*invalidateConversationPreload\(event\.conversation_id\)[\s\S]*loadMessages\(null, false\)/);

console.log("Message reporting: controlled violations, reversible selection, moderation removal and encrypted-content isolation verified");
