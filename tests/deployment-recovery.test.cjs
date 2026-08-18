const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const apiSource = fs.readFileSync(path.join(root, "web/js/api.js"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "web/sw.js"), "utf8");

const boot = app.slice(app.indexOf("async function boot()"), app.indexOf("function startupAuthenticationFailed"));
const socket = app.slice(app.indexOf("function connectSocket()"), app.indexOf("let adminNavigationPending"));
const refreshAll = app.slice(app.indexOf("async function refreshAll("), app.indexOf("async function refreshConversationList("));

assert.match(app, /const BOOT_API_TIMEOUT_MS = 8000/);
assert.match(boot, /api\("\/api\/me", \{ timeoutMS: BOOT_API_TIMEOUT_MS \}\)/);
assert.match(boot, /refreshAll\(\{ requestTimeoutMS: BOOT_API_TIMEOUT_MS \}\)/);
assert.match(socket, /if \(!appReady\) \{\s*retryIncompleteBoot\(\);/);
assert.match(app, /function retryIncompleteBoot\(\) \{\s*if \(appReady \|\| bootAttempt \|\| document\.hidden\) return;/);
assert.match(refreshAll, /const request = \(path, options = \{\}\) => api\(path, requestTimeoutMS > 0/);
assert.match(refreshAll, /request\("\/api\/contacts"\)/);
assert.match(refreshAll, /request\("\/api\/conversations"\)/);
assert.match(worker, /chat-pwa-go-v396/);
assert.match(worker, /\/js\/api\.js\?v=community-1-0-27-v396/);

(async () => {
  const originals = new Map(["window", "location", "localStorage", "fetch"].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]));
  const defineGlobal = (name, value) => Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
  defineGlobal("window", {});
  defineGlobal("location", { protocol: "https:", origin: "https://vibration.test", hostname: "vibration.test" });
  defineGlobal("localStorage", {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
  });
  defineGlobal("fetch", (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  }));
  try {
    const moduleURL = `data:text/javascript;base64,${Buffer.from(apiSource).toString("base64")}`;
    const { api } = await import(moduleURL);
    const startedAt = Date.now();
    await assert.rejects(api("/api/conversations", { timeoutMS: 20 }), /Serveur inaccessible/);
    assert.ok(Date.now() - startedAt < 1000, "une requête suspendue doit être abandonnée rapidement");
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
  console.log("Deployment recovery: stalled startup requests expire and conversations retry without a page reload");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
