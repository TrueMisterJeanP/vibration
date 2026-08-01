const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const responsiveLayout = app.slice(
  app.indexOf('const mobileLayout = window.matchMedia("(max-width: 720px)")'),
  app.indexOf('sidebarButton.onclick =', app.indexOf('const mobileLayout = window.matchMedia("(max-width: 720px)")')),
);
const sidebarLayout = app.slice(
  app.indexOf("const pauseMessageVideos = () =>"),
  app.indexOf('const mobileLayout = window.matchMedia("(max-width: 720px)")'),
);

assert.match(
  responsiveLayout,
  /if \(matches && !state\.current\) setSidebarOpen\(true\)/,
  "la sortie du plein écran ne doit pas rouvrir la liste lorsqu’une discussion est sélectionnée",
);
assert.match(sidebarLayout, /elements\.messages\.querySelectorAll\("video"\)/);
assert.match(sidebarLayout, /video\.webkitDisplayingFullscreen/);
assert.match(sidebarLayout, /if \(!fullscreen\) video\.pause\(\)/);

console.log("Mobile video fullscreen: conversation preserved and background playback prevented");
