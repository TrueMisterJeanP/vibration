const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const openCarnet = app.slice(
  app.indexOf("async function openCarnet"),
  app.indexOf("function renderCarnet"),
);
const renderCarnet = app.slice(
  app.indexOf("function renderCarnet"),
  app.indexOf("async function deleteCarnetEntry"),
);
const resumeCarnetEntry = app.slice(
  app.indexOf("async function resumeCarnetEntry"),
  app.indexOf("async function loadCalendarItems"),
);

assert.doesNotMatch(renderCarnet, /carnet-open-trigger/);
assert.match(renderCarnet, /entry\.has_private_conversation \? "Ouvrir" : "Contacter"/);
assert.match(renderCarnet, /open\.onclick = \(\) => resumeCarnetEntry\(entry, open\)/);
assert.match(html, /<strong>Supprimer les anciens contacts du carnet<\/strong>/);
assert.match(resumeCarnetEntry, /api\("\/api\/conversations\/private", \{ method: "POST", body: \{ user_id: entry\.contact_user_id \} \}\)/);
assert.match(resumeCarnetEntry, /api\("\/api\/contacts", \{ method: "POST", body: \{ user_id: entry\.contact_user_id \} \}\)/);
assert.match(resumeCarnetEntry, /await selectConversation\(selected\)/);
assert.match(app, /carnetLoaded: false/);
assert.match(app, /let carnetLoadVersion = 0;/);
assert.ok(
  openCarnet.indexOf("if (hadCachedCarnet) renderCarnet()") < openCarnet.indexOf('await api("/api/carnet")'),
  "le carnet mémorisé doit être rendu avant l’actualisation réseau",
);
assert.match(openCarnet, /if \(loadVersion !== carnetLoadVersion\) return;/);
assert.match(openCarnet, /if \(!hadCachedCarnet\) renderCarnet\(false\)/);
assert.match(app, /elements\.carnetDialog\.addEventListener\("close", \(\) => \{\s*carnetLoadVersion \+= 1;/);

console.log("Address book: cached contacts render immediately and explicit buttons open or request a private conversation");
