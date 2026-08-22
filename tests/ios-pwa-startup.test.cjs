const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../web/css/style.css"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const theme = fs.readFileSync(path.join(__dirname, "../web/js/theme.js"), "utf8");
const splashMark = fs.readFileSync(path.join(__dirname, "../web/icons/vibration-mark.svg"), "utf8");
const refreshAll = app.slice(
  app.indexOf("async function refreshAll"),
  app.indexOf("async function refreshConversationList"),
);

assert.match(theme, /isIOS[\s\S]*display-mode: standalone[\s\S]*navigator\.standalone === true/);
assert.match(theme, /const splashSymbolSize = 120/);
assert.match(theme, /const viewportSize = \(\) => \(\{[\s\S]*visualViewport\?\.width[\s\S]*visualViewport\?\.height/);
assert.ok(theme.indexOf("window.innerWidth") < theme.indexOf("window.visualViewport?.width"));
assert.match(theme, /viewportIsLandscape !== screenIsLandscape[\s\S]*\[width, height\] = \[height, width\]/);
assert.match(theme, /previousViewport[\s\S]*measurementCount[\s\S]*requestAnimationFrame\(positionStartupSymbol\)/);
assert.match(theme, /window\.addEventListener\("resize", scheduleStartupSymbolPosition\)/);
assert.match(theme, /window\.addEventListener\("orientationchange", scheduleStartupSymbolPosition\)/);
assert.match(theme, /window\.visualViewport\?\.addEventListener\?\.\("resize", scheduleStartupSymbolPosition\)/);
assert.match(theme, /const pageTopOffset = Math\.max\(0, screenSize\.height - viewport\.height\)/);
assert.match(theme, /--startup-symbol-y[\s\S]*\(screenSize\.height - splashSymbolSize\) \/ 2 - pageTopOffset/);
assert.match(theme, /classList\.add\("ios-pwa-splash-positioned"\)/);
assert.match(theme, /isIOS && isStandalone && isAppStart/);
assert.doesNotMatch(theme, /returnedFromAdmin|from=admin/);
const appShellTag = html.match(/<main id="app-shell"[^>]*>/)?.[0] || "";
assert.match(appShellTag, /\shidden(?:\s|>)/, "le shell ne doit pas exposer la transition mobile pendant son initialisation");
assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
assert.match(html, /id="startup-splash"[\s\S]*<img src="\/icons\/vibration-mark\.svg" alt="">/);
assert.match(splashMark, /stroke="#16836a"/);
assert.doesNotMatch(splashMark, /<rect\b/, "l’écran de démarrage doit afficher le losange seul");
const criticalSplashStyle = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
assert.match(criticalSplashStyle, /:root\s*\{[^}]*background-color:\s*#1b5260/);
assert.match(criticalSplashStyle, /html\[data-theme="light"\]\s*\{[^}]*--avatar-bg:\s*#dfe5e8[^}]*background-color:\s*#dfe5e8/);
assert.match(criticalSplashStyle, /html\.ios-pwa-starting,\s*html\.ios-pwa-starting body\s*\{[^}]*background:\s*var\(--avatar-bg\)/);
assert.match(criticalSplashStyle, /#startup-splash\s*\{\s*display:\s*none/);
assert.match(criticalSplashStyle, /html\.ios-pwa-starting #startup-splash:not\(\[hidden\]\)\s*\{[^}]*position:\s*fixed[^}]*top:\s*0[^}]*width:\s*var\(--startup-screen-width, 100vw\)[^}]*height:\s*var\(--startup-screen-height, 100vh\)/);
assert.match(criticalSplashStyle, /min-width:\s*100vw[^}]*min-height:\s*100vh/);
assert.match(criticalSplashStyle, /#startup-splash img\s*\{[^}]*position:\s*absolute[^}]*top:\s*var\(--startup-symbol-y, 0\)[^}]*visibility:\s*hidden/);
assert.match(criticalSplashStyle, /html\[data-theme="dark"\] #startup-splash img\s*\{[^}]*filter:\s*brightness\(0\) invert\(1\)/);
assert.match(criticalSplashStyle, /html\.ios-pwa-splash-positioned #startup-splash img\s*\{\s*visibility:\s*visible/);
assert.ok(html.indexOf("<style>") < html.indexOf("/css/style.css"), "critical splash layout must be available before the external stylesheet");
assert.match(css, /html\.ios-pwa-starting,\s*html\.ios-pwa-starting body\s*\{[^}]*background:\s*var\(--avatar-bg\)/);
assert.match(css, /html\.ios-pwa-starting #startup-splash\s*\{[^}]*position:\s*fixed[^}]*width:\s*var\(--startup-screen-width, 100vw\)[^}]*height:\s*var\(--startup-screen-height, 100vh\)[^}]*background:\s*var\(--avatar-bg\)/);
const splashRule = css.match(/html\.ios-pwa-starting #startup-splash\s*\{([^}]*)\}/)?.[1] || "";
assert.match(splashRule, /min-width:\s*100vw[\s\S]*min-height:\s*100vh/);
assert.doesNotMatch(splashRule, /100dvh|safe-area-inset/);
assert.match(css, /#startup-splash img\s*\{[^}]*top:\s*var\(--startup-symbol-y, 0\)[^}]*left:\s*var\(--startup-symbol-x[^}]*width:\s*120px[^}]*height:\s*120px[^}]*visibility:\s*hidden/);
assert.match(css, /html\[data-theme="dark"\] #startup-splash img\s*\{[^}]*filter:\s*brightness\(0\) invert\(1\)/);
assert.doesNotMatch(css.match(/#startup-splash img\s*\{([^}]*)\}/)?.[1] || "", /safe-area-inset-top/);
assert.match(app, /function dismissStartupSplash\(\)[\s\S]*classList\.remove\("ios-pwa-starting", "ios-pwa-splash-positioned"\)[\s\S]*startup-splash/);
assert.match(theme, /startupColor = resolved === "light" \? "#dfe5e8" : "#1b5260"/);
assert.match(theme, /classList\.contains\("ios-pwa-starting"\)[\s\S]*\? startupColor/);
assert.match(app, /classList\.remove\("ios-pwa-starting", "ios-pwa-splash-positioned"\);\s*window\.ChatTheme\?\.refresh\(\)/);
const cachedRender = refreshAll.slice(0, refreshAll.indexOf("try {"));
assert.doesNotMatch(cachedRender, /dismissStartupSplash\(\)/);
assert.match(refreshAll, /await renderConversations\(\{ freshMembers: true \}\);[\s\S]*?scheduleBackgroundConversationPreloads\(conversations\);[\s\S]*?await preload;\s*dismissStartupSplash\(\)/);
assert.match(refreshAll, /scheduleBackgroundConversationPreloads\(cachedConversations\);[\s\S]*?await preload;\s*dismissStartupSplash\(\)/);

const startupProperties = new Map();
const startupClasses = new Set();
const windowListeners = new Map();
const lightMedia = { matches: false, addEventListener() {} };
const document = {
  hidden: false,
  documentElement: {
    dataset: {},
    style: {
      setProperty(name, value) { startupProperties.set(name, value); },
    },
    classList: {
      add(...names) { names.forEach((name) => startupClasses.add(name)); },
      contains(name) { return startupClasses.has(name); },
    },
  },
  querySelector() { return { content: "" }; },
  addEventListener() {},
};
const window = {
  screen: { width: 1024, height: 1366 },
  innerWidth: 1366,
  innerHeight: 1024,
  visualViewport: { width: 1024, height: 1366, addEventListener() {} },
  matchMedia(query) {
    return query === "(display-mode: standalone)" ? { matches: true } : lightMedia;
  },
  addEventListener(name, callback) { windowListeners.set(name, callback); },
};
vm.runInNewContext(theme, {
  document,
  localStorage: { getItem() { return null; }, setItem() {} },
  location: { pathname: "/" },
  navigator: { userAgent: "iPad", platform: "iPad", maxTouchPoints: 5, standalone: true },
  requestAnimationFrame(callback) { callback(); },
  window,
});
assert.equal(startupProperties.get("--startup-screen-width"), "1366px");
assert.equal(startupProperties.get("--startup-screen-height"), "1024px");
assert.equal(startupProperties.get("--startup-symbol-x"), "623px");
assert.equal(startupProperties.get("--startup-symbol-y"), "452px");
assert.ok(startupClasses.has("ios-pwa-splash-positioned"));

window.innerWidth = 1024;
window.innerHeight = 1366;
window.visualViewport.width = 1366;
window.visualViewport.height = 1024;
windowListeners.get("orientationchange")();
assert.equal(startupProperties.get("--startup-screen-width"), "1024px");
assert.equal(startupProperties.get("--startup-screen-height"), "1366px");
assert.equal(startupProperties.get("--startup-symbol-x"), "452px");
assert.equal(startupProperties.get("--startup-symbol-y"), "623px");

console.log("iOS PWA startup: splash remains centered in portrait and landscape until messages are ready");
