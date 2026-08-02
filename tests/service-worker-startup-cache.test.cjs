const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const worker = fs.readFileSync(path.join(__dirname, "../web/sw.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../web/manifest.json"), "utf8"));
const fetchHandler = worker.slice(
  worker.indexOf('self.addEventListener("fetch"'),
  worker.indexOf('self.addEventListener("push"'),
);
const startupBranch = fetchHandler.slice(
  fetchHandler.indexOf("if (STARTUP_CACHE_PATHS.has"),
  fetchHandler.indexOf("event.respondWith(\n    fetch(event.request)"),
);

assert.match(worker, /const STARTUP_CACHE_PATHS = new Set\(\["\/", "\/index\.html", "\/css\/style\.css", "\/js\/theme\.js"\]\)/);
assert.ok(
  startupBranch.indexOf("caches.match(event.request)") < startupBranch.indexOf("fetch(event.request)"),
  "l’écran de démarrage doit être lu dans Cache Storage avant toute requête réseau",
);
assert.match(startupBranch, /if \(cached\) return cached/);
assert.equal(manifest.background_color, "#1b5260");

console.log("Service Worker startup cache: green splash shell is served locally before the network");
