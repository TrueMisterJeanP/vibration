const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");

assert.match(html, /id="conversation-list-loading"[^>]*role="status"[^>]*>Chargement des discussions…<\/div>/);
assert.match(
  html,
  /id="conversation-lists"[^>]*aria-busy="true"[^>]*hidden[\s\S]*id="personal-conversation-button"[\s\S]*id="conversation-list"/,
  "les notes personnelles et les autres discussions doivent partager la même barrière d’affichage",
);
assert.match(css, /#conversation-lists\s*\{[^}]*display:\s*flex[^}]*flex:\s*1[^}]*flex-direction:\s*column/);
assert.match(css, /\.conversation-list-loading\s*\{[^}]*display:\s*grid[^}]*flex:\s*1/);

const revealStart = app.indexOf("function revealConversationLists()");
const revealEnd = app.indexOf("function refreshCarnetInBackground()", revealStart);
assert.ok(revealStart >= 0 && revealEnd > revealStart);

const context = {
  elements: {
    conversationLists: {
      hidden: true,
      attributes: new Set(["aria-busy"]),
      removeAttribute(name) {
        this.attributes.delete(name);
      },
    },
    conversationListLoading: { hidden: false },
  },
};
vm.createContext(context);
vm.runInContext(`${app.slice(revealStart, revealEnd)}\nglobalThis.revealConversationLists = revealConversationLists;`, context);
context.revealConversationLists();
assert.equal(context.elements.conversationLists.hidden, false);
assert.equal(context.elements.conversationLists.attributes.has("aria-busy"), false);
assert.equal(context.elements.conversationListLoading.hidden, true);

const refreshStart = app.indexOf("async function refreshAll(");
const refreshEnd = app.indexOf("async function refreshConversationList()", refreshStart);
const refreshAll = app.slice(refreshStart, refreshEnd);
const firstCachedRender = refreshAll.indexOf("await renderConversations();");
const firstReveal = refreshAll.indexOf("revealConversationLists();", firstCachedRender);
const networkLoad = refreshAll.indexOf("let [contacts, conversations] = await Promise.all");
assert.ok(firstCachedRender >= 0 && firstReveal > firstCachedRender && networkLoad > firstReveal);

const networkLoadEnd = refreshAll.indexOf("]);", networkLoad);
const networkRequests = refreshAll.slice(networkLoad, networkLoadEnd);
assert.match(networkRequests, /request\("\/api\/contacts"\)/);
assert.match(networkRequests, /request\("\/api\/conversations"\)/);
assert.doesNotMatch(networkRequests, /carnet/, "le carnet ne doit pas retarder l’affichage des discussions");
assert.match(refreshAll, /void refreshCarnetInBackground\(\);/);

const freshRender = refreshAll.indexOf("await renderConversations({ freshMembers: true });");
const freshReveal = refreshAll.indexOf("revealConversationLists();", freshRender);
const backgroundPreload = refreshAll.indexOf("scheduleBackgroundConversationPreloads(conversations)", freshRender);
assert.ok(freshRender >= 0 && freshReveal > freshRender && backgroundPreload > freshReveal);

const fallbackRender = refreshAll.lastIndexOf("await renderConversations();");
const fallbackReveal = refreshAll.indexOf("revealConversationLists();", fallbackRender);
assert.ok(fallbackRender > freshRender && fallbackReveal > fallbackRender);

console.log("conversation list readiness tests: ok");
