const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const start = app.indexOf("function setPinnedPanelVisibility(open)");
const end = app.indexOf("async function loadPinnedMessages", start);

assert.ok(start >= 0 && end > start, "l’ouverture du panneau épinglé doit rester testable isolément");
assert.match(app, /let pinnedPanelOpenTask = null;/);
assert.match(app, /loadPinnedMessages\(\{ allowHidden: true, renderLoading: false, throwOnError: true \}\)/);

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
  const buttonAttributes = new Map();
  const listAttributes = new Map();
  const panel = { hidden: true };
  const button = {
    disabled: false,
    title: "",
    setAttribute(name, value) {
      buttonAttributes.set(name, value);
    },
    removeAttribute(name) {
      buttonAttributes.delete(name);
    },
  };
  const pinnedMessages = {
    removeAttribute(name) {
      listAttributes.delete(name);
    },
  };
  const classToggles = [];
  const context = {
    elements: {
      pinnedPanel: panel,
      pinnedMessages,
      pinnedWindowButton: button,
      chatWorkspace: {
        classList: {
          toggle(name, enabled) {
            classToggles.push([name, enabled]);
          },
        },
      },
    },
    state: { current: { id: "conversation-1" } },
    loadCalls: [],
    toastCalls: [],
    loadPinnedMessages(options) {
      context.loadCalls.push(options);
      return loading.promise;
    },
    t(value) {
      return value;
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
    `let pinnedPanelOpenTask = null;\nlet pinnedPanelLoadVersion = 0;\n${app.slice(start, end)}\nglobalThis.setPinnedPanelOpen = setPinnedPanelOpen;`,
    context,
  );
  return { button, buttonAttributes, classToggles, context, loading, panel };
}

(async () => {
  const success = createHarness();
  const firstOpen = success.context.setPinnedPanelOpen(true);
  const secondOpen = success.context.setPinnedPanelOpen(true);

  assert.equal(success.context.loadCalls.length, 1, "un double clic ne doit lancer qu’un chargement");
  assert.equal(success.context.loadCalls[0].allowHidden, true);
  assert.equal(success.context.loadCalls[0].renderLoading, false);
  assert.equal(success.context.loadCalls[0].throwOnError, true);
  assert.equal(success.panel.hidden, true, "le panneau doit rester masqué pendant le chargement");
  assert.deepEqual(success.classToggles, [], "la mise en page ne doit pas bouger avant le rendu complet");
  assert.equal(success.button.disabled, true);
  assert.equal(success.buttonAttributes.get("aria-busy"), "true");

  success.loading.resolve(true);
  await Promise.all([firstOpen, secondOpen]);

  assert.equal(success.panel.hidden, false, "le panneau doit s’ouvrir une fois son contenu prêt");
  assert.deepEqual(success.classToggles, [["pinned-open", true]]);
  assert.equal(success.buttonAttributes.get("aria-expanded"), "true");
  assert.equal(success.button.disabled, false);
  assert.equal(success.buttonAttributes.has("aria-busy"), false);

  await success.context.setPinnedPanelOpen(false);
  assert.equal(success.panel.hidden, true);
  assert.deepEqual(success.classToggles.at(-1), ["pinned-open", false]);
  assert.equal(success.buttonAttributes.get("aria-expanded"), "false");

  const failure = createHarness();
  const failedOpen = failure.context.setPinnedPanelOpen(true);
  failure.loading.reject(new Error("indisponible"));
  await failedOpen;

  assert.equal(failure.panel.hidden, true, "un échec ne doit pas afficher une liste vide");
  assert.deepEqual(failure.classToggles, []);
  assert.deepEqual(failure.context.toastCalls, [
    { message: "Impossible de charger les messages épinglés.", kind: "error" },
  ]);
  assert.equal(failure.button.disabled, false);
  assert.equal(failure.buttonAttributes.has("aria-busy"), false);

  const cancelled = createHarness();
  const cancelledOpen = cancelled.context.setPinnedPanelOpen(true);
  await cancelled.context.setPinnedPanelOpen(false);
  cancelled.loading.resolve(true);
  await cancelledOpen;
  assert.equal(cancelled.panel.hidden, true, "une ouverture annulée ne doit pas réapparaître après le chargement");

  console.log("pinned panel loading tests: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
