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
assert.match(startupBranch, /if \(cached\) \{[\s\S]*fetch\(event\.request\)[\s\S]*return cached;/);
assert.match(worker, /"\/vendor\/hash-wasm\/argon2\.umd\.min\.js\?v=identity-v2"/);
assert.equal(manifest.background_color, "#1b5260");

// app.js imports the call negotiation module. If the module were missing from
// the shell, an offline start would load a new app.js against a module the
// cache cannot serve, and every call would fail at import time.
const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const page = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const moduleVersion = app.match(/from "\.\/call-negotiation\.js\?v=([^"]+)"/)?.[1];
assert.ok(moduleVersion, "app.js must import the call negotiation module with a cache-busting version");
assert.ok(
  worker.includes(`"/js/call-negotiation.js?v=${moduleVersion}"`),
  "the call negotiation module must be in the service worker shell, at the version app.js imports",
);
// The two files must move together: a cached old app.js paired with a new
// module — or the reverse — is exactly the mismatch versioning must prevent.
const appVersion = worker.match(/"\/js\/app\.js\?v=([^"]+)"/)?.[1];
assert.equal(appVersion, moduleVersion, "app.js and the negotiation module must share one cache-busting version");
assert.ok(
  page.includes(`/js/app.js?v=${appVersion}`),
  "index.html must request the same app.js version the service worker caches",
);
const cryptoVersion = app.match(/from "\.\/crypto\.js\?v=([^"]+)"/)?.[1];
assert.equal(cryptoVersion, appVersion, "app.js and crypto.js must share one cache-busting version");
assert.ok(
  worker.includes(`"/js/crypto.js?v=${cryptoVersion}"`),
  "the exact crypto.js imported by app.js must be in the service worker shell",
);
const cacheVersion = worker.match(/const CACHE = "chat-pwa-go-v(\d+)"/)?.[1];
assert.ok(Number(cacheVersion) >= 313, "the cache generation must be bumped when the shell changes");

console.log("Service Worker startup cache: green splash shell is served locally before the network");
