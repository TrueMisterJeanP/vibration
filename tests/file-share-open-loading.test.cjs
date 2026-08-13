const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const start = app.indexOf("async function openFileShareDialog(");
const end = app.indexOf("async function loadExistingFileShares(", start);

assert.ok(start >= 0 && end > start, "l’ouverture du formulaire de partage doit rester testable isolément");
assert.match(app, /let fileShareOpenTask = null;/);
assert.match(app, /let fileShareOpenVersion = 0;/);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const loading = deferred();
  const timeline = [];
  const triggerAttributes = new Map();
  const trigger = {
    disabled: false,
    setAttribute(name, value) {
      triggerAttributes.set(name, value);
    },
    removeAttribute(name) {
      triggerAttributes.delete(name);
    },
  };
  const fileShareDialog = {
    open: false,
    showModal() {
      this.open = true;
      timeline.push("shown");
    },
  };
  const context = {
    elements: {
      fileShareDialog,
      fileShareName: { textContent: "" },
      fileShareExpiration: { value: "", disabled: false },
      fileShareError: { textContent: "" },
      fileShareURL: { value: "" },
      fileShareValidity: { textContent: "" },
      fileShareResult: { hidden: false },
      fileShareCreateActions: { hidden: true },
      fileShareCopy: { disabled: true },
      fileShareRevoke: { disabled: true },
      fileShareExisting: { hidden: false },
      fileShareExistingList: { replaceChildren() {} },
    },
    state: { pendingFileShare: null, activeFileShareID: null },
    loadCalls: 0,
    toastCalls: [],
    loadExistingFileShares(_message, _conversation, options) {
      context.loadCalls += 1;
      context.loadOptions = options;
      timeline.push("load");
      return loading.promise.then((loaded) => {
        timeline.push("loaded");
        return loaded;
      });
    },
    sameID(left, right) {
      return String(left) === String(right);
    },
    frenchErrorMessage(_error, fallback) {
      return fallback;
    },
    toast(message, kind) {
      context.toastCalls.push({ message, kind });
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `let fileShareOpenTask = null;\nlet fileShareOpenVersion = 0;\n${app.slice(start, end)}\nglobalThis.openFileShareDialog = openFileShareDialog;`,
    context,
  );
  return { context, fileShareDialog, loading, timeline, trigger, triggerAttributes };
}

(async () => {
  const message = { id: "message-1", file: { id: "file-1" } };
  const clear = { name: "rapport.pdf" };
  const conversation = { id: "conversation-1" };
  const success = createHarness();
  const firstOpen = success.context.openFileShareDialog(message, clear, conversation, success.trigger);
  const secondOpen = success.context.openFileShareDialog(message, clear, conversation, success.trigger);

  assert.equal(success.context.loadCalls, 1, "un double clic ne doit lancer qu’un chargement");
  assert.equal(success.fileShareDialog.open, false, "le formulaire doit rester masqué pendant le chargement");
  assert.equal(success.trigger.disabled, true);
  assert.equal(success.triggerAttributes.get("aria-busy"), "true");
  assert.equal(success.context.loadOptions.throwOnError, true);
  assert.equal(success.context.loadOptions.isRelevant(), true);

  success.loading.resolve(true);
  await Promise.all([firstOpen, secondOpen]);

  assert.deepEqual(success.timeline, ["load", "loaded", "shown"]);
  assert.equal(success.fileShareDialog.open, true);
  assert.equal(success.context.elements.fileShareName.textContent, "rapport.pdf");
  assert.equal(success.trigger.disabled, false);
  assert.equal(success.triggerAttributes.has("aria-busy"), false);

  const failure = createHarness();
  const failedOpen = failure.context.openFileShareDialog(message, clear, conversation, failure.trigger);
  failure.loading.reject(new Error("indisponible"));
  await failedOpen;

  assert.equal(failure.fileShareDialog.open, false, "un échec ne doit pas afficher un formulaire incomplet");
  assert.equal(failure.context.state.pendingFileShare, null);
  assert.deepEqual(failure.context.toastCalls, [
    { message: "Impossible de charger les liens de partage.", kind: "error" },
  ]);
  assert.equal(failure.trigger.disabled, false);
  assert.equal(failure.triggerAttributes.has("aria-busy"), false);

  console.log("file share open loading tests: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
