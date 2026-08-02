const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../web/index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../web/css/style.css"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const theme = fs.readFileSync(path.join(__dirname, "../web/js/theme.js"), "utf8");
const refreshAll = app.slice(
  app.indexOf("async function refreshAll"),
  app.indexOf("async function refreshConversationList"),
);

assert.match(theme, /isIOS[\s\S]*display-mode: standalone[\s\S]*navigator\.standalone === true/);
assert.match(theme, /const screenHeight = window\.screen\.height \|\| window\.innerHeight/);
assert.match(theme, /const splashSymbolSize = 120/);
assert.match(theme, /previousViewportHeight[\s\S]*measurementCount[\s\S]*requestAnimationFrame\(positionStartupSymbol\)/);
assert.match(theme, /const pageTopOffset = Math\.max\(0, screenHeight - viewportHeight\)/);
assert.match(theme, /--startup-symbol-y[\s\S]*\(screenHeight - splashSymbolSize\) \/ 2 - pageTopOffset/);
assert.match(theme, /classList\.add\("ios-pwa-splash-positioned"\)/);
assert.match(theme, /isIOS && isStandalone && isAppStart/);
assert.doesNotMatch(theme, /returnedFromAdmin|from=admin/);
const appShellTag = html.match(/<main id="app-shell"[^>]*>/)?.[0] || "";
assert.match(appShellTag, /\shidden(?:\s|>)/, "le shell ne doit pas exposer la transition mobile pendant son initialisation");
assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
assert.match(html, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
assert.match(html, /id="startup-splash"[\s\S]*<svg[^>]*viewBox="0 0 24 24"[\s\S]*M12 4 20 12 12 20 4 12Z/);
const criticalSplashStyle = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
assert.match(criticalSplashStyle, /#startup-splash\s*\{\s*display:\s*none/);
assert.match(criticalSplashStyle, /html\.ios-pwa-starting #startup-splash:not\(\[hidden\]\)\s*\{[^}]*position:\s*fixed[^}]*top:\s*0[^}]*width:\s*var\(--startup-screen-width, 100vw\)[^}]*height:\s*var\(--startup-screen-height, 100vh\)/);
assert.match(criticalSplashStyle, /#startup-splash svg\s*\{[^}]*position:\s*absolute[^}]*top:\s*var\(--startup-symbol-y, 0\)[^}]*visibility:\s*hidden/);
assert.match(criticalSplashStyle, /html\.ios-pwa-splash-positioned #startup-splash svg\s*\{\s*visibility:\s*visible/);
assert.ok(html.indexOf("<style>") < html.indexOf("/css/style.css"), "critical splash layout must be available before the external stylesheet");
assert.match(css, /html\.ios-pwa-starting #startup-splash\s*\{[^}]*position:\s*fixed[^}]*width:\s*var\(--startup-screen-width, 100vw\)[^}]*height:\s*var\(--startup-screen-height, 100vh\)[^}]*background:\s*var\(--avatar-bg\)/);
const splashRule = css.match(/html\.ios-pwa-starting #startup-splash\s*\{([^}]*)\}/)?.[1] || "";
assert.doesNotMatch(splashRule, /100dvh|safe-area-inset/);
assert.match(css, /#startup-splash svg\s*\{[^}]*top:\s*var\(--startup-symbol-y, 0\)[^}]*left:\s*var\(--startup-symbol-x[^}]*width:\s*120px[^}]*height:\s*120px[^}]*visibility:\s*hidden[^}]*stroke:\s*var\(--avatar-fg\)/);
assert.doesNotMatch(css.match(/#startup-splash svg\s*\{([^}]*)\}/)?.[1] || "", /safe-area-inset-top/);
assert.match(app, /function dismissStartupSplash\(\)[\s\S]*classList\.remove\("ios-pwa-starting", "ios-pwa-splash-positioned"\)[\s\S]*startup-splash/);
assert.match(theme, /startupColor = resolved === "light" \? "#c9e7e4" : "#1b5260"/);
assert.match(theme, /classList\.contains\("ios-pwa-starting"\)[\s\S]*\? startupColor/);
assert.match(app, /classList\.remove\("ios-pwa-starting", "ios-pwa-splash-positioned"\);\s*window\.ChatTheme\?\.refresh\(\)/);
const cachedRender = refreshAll.slice(0, refreshAll.indexOf("try {"));
assert.doesNotMatch(cachedRender, /dismissStartupSplash\(\)/);
assert.match(refreshAll, /await renderConversations\(\{ freshMembers: true \}\);[\s\S]*?scheduleBackgroundConversationPreloads\(conversations\);[\s\S]*?await preload;\s*dismissStartupSplash\(\)/);
assert.match(refreshAll, /scheduleBackgroundConversationPreloads\(cachedConversations\);[\s\S]*?await preload;\s*dismissStartupSplash\(\)/);

console.log("iOS PWA startup: icon-colored splash remains until prioritized messages are ready");
