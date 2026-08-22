const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const share = fs.readFileSync(path.join(root, "web/js/share.js"), "utf8");
const shareHTML = fs.readFileSync(path.join(root, "web/share.html"), "utf8");
const requestStart = share.indexOf("async function requestSharedFileDownload(");
const requestEnd = share.indexOf("async function init()", requestStart);
const downloadButton = shareHTML.match(/<button id="share-download-button"[^>]*>/)?.[0] || "";

assert.ok(requestStart >= 0 && requestEnd > requestStart, "la demande de téléchargement doit rester testable isolément");
assert.ok(downloadButton, "le bouton de téléchargement doit exister");
assert.doesNotMatch(downloadButton, /\sdisabled(?:\s|=|>)/, "le bouton doit être actif dès le rendu HTML");
assert.ok(
  share.indexOf('elements.download.addEventListener("click"') < share.indexOf("init().catch("),
  "le clic doit être branché avant le démarrage asynchrone de la page",
);
assert.match(share, /const AUTOMATIC_DOWNLOAD_DELAY_MS = 2000;/);
assert.match(share, /if \(!manualDownloadRequested\) \{[\s\S]*setTimeout\([\s\S]*requestSharedFileDownload\(true\)/);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(preparation) {
  const downloads = [];
  const clearedTimers = [];
  const context = {
    preparation,
    downloads,
    clearedTimers,
    elements: {
      error: { textContent: "ancienne erreur" },
      status: { textContent: "" },
    },
    t: (value) => value,
    clearTimeout: (timer) => clearedTimers.push(timer),
    downloadSharedFile: async (automatic) => downloads.push(automatic),
  };
  vm.createContext(context);
  vm.runInContext(
    `let sharePreparation = preparation;
let manualDownloadRequested = false;
let automaticDownloadTimer = 42;
${share.slice(requestStart, requestEnd)}
globalThis.requestSharedFileDownload = requestSharedFileDownload;
globalThis.wasManuallyRequested = () => manualDownloadRequested;
globalThis.currentAutomaticTimer = () => automaticDownloadTimer;`,
    context,
  );
  return context;
}

(async () => {
  const pending = deferred();
  const manual = createHarness(pending.promise);
  const manualRequest = manual.requestSharedFileDownload(false);

  assert.equal(manual.wasManuallyRequested(), true);
  assert.equal(manual.elements.status.textContent, "Préparation du téléchargement…");
  assert.equal(manual.elements.error.textContent, "");
  assert.deepEqual(manual.clearedTimers, [42]);
  assert.equal(manual.currentAutomaticTimer(), null);
  assert.deepEqual(manual.downloads, [], "le clic doit attendre les métadonnées sans être perdu");

  await manual.requestSharedFileDownload(true);
  assert.deepEqual(manual.downloads, [], "l’automatisme doit s’annuler après un clic manuel");

  pending.resolve();
  await manualRequest;
  assert.deepEqual(manual.downloads, [false], "le clic anticipé doit lancer un unique téléchargement manuel");

  const automatic = createHarness(Promise.resolve());
  await automatic.requestSharedFileDownload(true);
  assert.deepEqual(automatic.downloads, [true], "le téléchargement automatique doit rester disponible sans clic");

  console.log("file share immediate download tests: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
