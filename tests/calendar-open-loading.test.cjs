const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const start = app.indexOf("async function openCalendar()");
const end = app.indexOf("async function openCarnet()", start);

assert.ok(start >= 0 && end > start, "openCalendar doit rester testable isolément");
assert.match(app, /let calendarOpenTask = null;/);

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
  const attributes = new Map();
  const oldItems = [{ id: "ancien" }];
  const calendarDialog = {
    open: false,
    showModal() {
      this.open = true;
      timeline.push("shown");
    },
  };
  const calendarButton = {
    disabled: false,
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
  };
  const context = {
    elements: { calendarButton, calendarDialog },
    state: { calendarItems: oldItems },
    loadCalls: 0,
    renderedItems: null,
    toastCalls: [],
    loadCalendarItems() {
      context.loadCalls += 1;
      timeline.push("load");
      return loading.promise;
    },
    showCurrentCalendarMonth() {
      context.renderedItems = [...context.state.calendarItems];
      timeline.push("render");
    },
    frenchErrorMessage(_error, fallback) {
      return fallback;
    },
    toast(message, kind) {
      context.toastCalls.push({ message, kind });
      timeline.push("toast");
    },
  };

  vm.createContext(context);
  vm.runInContext(
    `let calendarOpenTask = null;\n${app.slice(start, end)}\nglobalThis.openCalendar = openCalendar;`,
    context,
  );
  return { attributes, calendarButton, calendarDialog, context, loading, oldItems, timeline };
}

(async () => {
  const success = createHarness();
  const firstOpen = success.context.openCalendar();
  const secondOpen = success.context.openCalendar();

  assert.equal(success.context.loadCalls, 1, "un double clic ne doit lancer qu'un chargement");
  assert.equal(success.calendarDialog.open, false, "le calendrier doit rester masqué pendant le chargement");
  assert.equal(success.context.renderedItems, null, "aucun calendrier vide ne doit être rendu");
  assert.equal(success.context.state.calendarItems, success.oldItems, "les anciennes données ne doivent pas être effacées");
  assert.equal(success.calendarButton.disabled, true);
  assert.equal(success.attributes.get("aria-busy"), "true");

  const loadedItems = [{ id: "evenement-charge" }];
  success.loading.resolve(loadedItems);
  await Promise.all([firstOpen, secondOpen]);

  assert.deepEqual(success.timeline, ["load", "render", "shown"]);
  assert.equal(success.calendarDialog.open, true);
  assert.deepEqual(success.context.renderedItems, loadedItems);
  assert.equal(success.context.state.calendarItems, loadedItems);
  assert.equal(success.calendarButton.disabled, false);
  assert.equal(success.attributes.has("aria-busy"), false);

  await success.context.openCalendar();
  assert.equal(success.context.loadCalls, 1, "un calendrier déjà ouvert ne doit pas être rechargé");

  const failure = createHarness();
  const failedOpen = failure.context.openCalendar();
  failure.loading.reject(new Error("indisponible"));
  await failedOpen;

  assert.equal(failure.calendarDialog.open, false, "un échec ne doit pas afficher un calendrier vide");
  assert.equal(failure.context.renderedItems, null);
  assert.equal(failure.context.state.calendarItems, failure.oldItems);
  assert.deepEqual(failure.context.toastCalls, [
    { message: "Impossible de charger le calendrier.", kind: "error" },
  ]);
  assert.equal(failure.calendarButton.disabled, false);
  assert.equal(failure.attributes.has("aria-busy"), false);

  console.log("calendar open loading tests: ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
