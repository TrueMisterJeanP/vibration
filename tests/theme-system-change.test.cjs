const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const themeSource = fs.readFileSync(path.join(__dirname, "../web/js/theme.js"), "utf8");

function startTheme({ savedTheme = null, legacyMediaQuery = false } = {}) {
  let systemIsLight = false;
  const windowListeners = new Map();
  const documentListeners = new Map();
  let mediaChangeListener = null;
  const stored = new Map();
  if (savedTheme !== null) stored.set("chat-theme", savedTheme);

  const colorSchemeMedia = {
    get matches() {
      return systemIsLight;
    },
  };
  if (legacyMediaQuery) {
    colorSchemeMedia.addListener = (listener) => {
      mediaChangeListener = listener;
    };
  } else {
    colorSchemeMedia.addEventListener = (event, listener) => {
      if (event === "change") mediaChangeListener = listener;
    };
  }

  const documentElement = {
    dataset: {},
    style: {
      colorScheme: "",
      setProperty() {},
    },
    classList: {
      add() {},
      contains() { return false; },
    },
  };
  const themeColor = { content: "" };
  const document = {
    hidden: false,
    documentElement,
    querySelector(selector) {
      return selector === 'meta[name="theme-color"]' ? themeColor : null;
    },
    addEventListener(event, listener) {
      documentListeners.set(event, listener);
    },
  };
  const window = {
    screen: { width: 1024, height: 1366 },
    innerWidth: 1024,
    innerHeight: 1366,
    matchMedia(query) {
      if (query === "(prefers-color-scheme: light)") return colorSchemeMedia;
      return { matches: false };
    },
    addEventListener(event, listener) {
      windowListeners.set(event, listener);
    },
  };

  vm.runInNewContext(themeSource, {
    document,
    localStorage: {
      getItem(key) { return stored.get(key) ?? null; },
      setItem(key, value) { stored.set(key, value); },
    },
    location: { pathname: "/conversation" },
    navigator: { userAgent: "", platform: "", maxTouchPoints: 0, standalone: false },
    window,
  });

  return {
    document,
    documentElement,
    window,
    setSystemTheme(theme) {
      systemIsLight = theme === "light";
    },
    signalSystemChange() {
      assert.equal(typeof mediaChangeListener, "function", "le changement système doit être observé");
      mediaChangeListener();
    },
    showPage() {
      windowListeners.get("pageshow")?.();
    },
    focusPage() {
      windowListeners.get("focus")?.();
    },
    changeVisibility() {
      documentListeners.get("visibilitychange")?.();
    },
  };
}

const automatic = startTheme();
assert.equal(automatic.documentElement.dataset.theme, "dark");
automatic.setSystemTheme("light");
automatic.signalSystemChange();
assert.equal(automatic.documentElement.dataset.theme, "light", "le thème automatique doit suivre iPadOS");

automatic.setSystemTheme("dark");
automatic.showPage();
assert.equal(automatic.documentElement.dataset.theme, "dark", "pageshow doit réparer un événement manqué pendant la suspension");
automatic.setSystemTheme("light");
automatic.focusPage();
assert.equal(automatic.documentElement.dataset.theme, "light", "le retour au premier plan doit resynchroniser le thème");
automatic.document.hidden = true;
automatic.setSystemTheme("dark");
automatic.changeVisibility();
assert.equal(automatic.documentElement.dataset.theme, "light", "une page encore masquée ne doit pas être rafraîchie");
automatic.document.hidden = false;
automatic.changeVisibility();
assert.equal(automatic.documentElement.dataset.theme, "dark");

const manual = startTheme({ savedTheme: "dark" });
manual.setSystemTheme("light");
manual.signalSystemChange();
manual.showPage();
assert.equal(manual.documentElement.dataset.theme, "dark", "un choix manuel doit rester fixe");
manual.window.ChatTheme.setPreference("auto");
assert.equal(manual.documentElement.dataset.theme, "light");

const legacy = startTheme({ legacyMediaQuery: true });
legacy.setSystemTheme("light");
legacy.signalSystemChange();
assert.equal(legacy.documentElement.dataset.theme, "light", "l’ancienne API MediaQueryList de Safari doit rester prise en charge");

console.log("Theme: automatic appearance follows iPadOS changes and PWA resume events");
