const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const websocketSource = fs.readFileSync(path.join(root, "web/js/websocket.js"), "utf8");
const notifications = fs.readFileSync(path.join(root, "web/js/notifications.js"), "utf8");
const worker = fs.readFileSync(path.join(root, "web/sw.js"), "utf8");
const boot = app.slice(app.indexOf("async function boot()"), app.indexOf("function startupAuthenticationFailed"));
const recovery = app.slice(app.indexOf("function startupAuthenticationFailed"), app.indexOf("async function initializeNotificationsAfterBoot"));
const foreground = app.slice(app.indexOf("function handleAppFocus"), app.indexOf("function conversationCallState"));

assert.match(app, /let appShellPrepared = false;[\s\S]*let appUIBound = false;[\s\S]*let bootAttempt = null;/);
assert.match(boot, /if \(!state\.me\)[\s\S]*Promise\.all\(\[[\s\S]*api\("\/api\/me", \{ timeoutMS: BOOT_API_TIMEOUT_MS \}\)/);
assert.match(boot, /if \(!appShellPrepared\)[\s\S]*appShellPrepared = true/);
assert.match(boot, /if \(!appUIBound\)[\s\S]*bindUI\(\);[\s\S]*appUIBound = true/);
assert.match(boot, /if \(!state\.socket \|\| state\.socket\.closed\) connectSocket\(\)/);
assert.doesNotMatch(boot, /catch[\s\S]*location\.replace\("\/login\.html"\)/);
assert.match(recovery, /error\?\.status === 401 \|\| error\?\.status === 403/);
assert.match(recovery, /bootRetryDelay = Math\.min\(bootRetryDelay \* 2, 15000\)/);
assert.match(recovery, /if \(bootAttempt\) return bootAttempt/);
assert.match(recovery, /scheduleBootRetry\(\)/);
assert.match(app, /const BOOT_API_TIMEOUT_MS = 8000/);
assert.match(app, /addEventListener\("online", retryIncompleteBoot\)/);
assert.match(app, /addEventListener\("pageshow", retryIncompleteBoot\)/);
assert.match(app, /addEventListener\("visibilitychange", retryIncompleteBoot\)/);
assert.match(app, /if \(sessionQRScannerDialog && sessionQRScannerButton && sessionQRScannerClose && sessionQRScannerCancel && sessionQRScannerFile\)/);
assert.doesNotMatch(app, /document\.querySelector\("#profile-session-scan-qr"\)\.onclick/);
assert.match(app, /video\?\.pause\(\)/);
assert.match(app, /if \(dialog\?\.open\) dialog\.close\(\)/);
assert.match(foreground, /Date\.now\(\) - appHiddenAt >= 3000/);
assert.match(foreground, /refreshConversationListOnForeground\(\{ reconnectSocket: suspended \}\)/);
assert.match(foreground, /if \(reconnectSocket\) state\.socket\?\.reconnect\(\)/);
assert.match(notifications, /register\("\/sw\.js\?v=personal-notes-theme-v343"\)/);
assert.match(worker, /chat-pwa-go-v343/);
assert.match(worker, /\/js\/app\.js\?v=personal-notes-theme-v343/);
assert.match(worker, /\/js\/notifications\.js\?v=personal-notes-theme-v343/);
assert.match(worker, /\/js\/websocket\.js\?v=personal-notes-theme-v343/);

const executableWebSocketSource = websocketSource.replace(
  /^import[^\n]+\n/,
  'const websocketProtocols = () => []; const websocketURL = () => "wss://vibration.test/api/ws";\n',
);

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  send() {}
}

class FakeCustomEvent extends Event {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

(async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalCustomEvent = globalThis.CustomEvent;
  globalThis.WebSocket = FakeWebSocket;
  globalThis.CustomEvent = FakeCustomEvent;
  try {
    const moduleURL = `data:text/javascript;base64,${Buffer.from(executableWebSocketSource).toString("base64")}`;
    const { ChatSocket } = await import(moduleURL);
    const statuses = [];
    const chatSocket = new ChatSocket();
    chatSocket.addEventListener("status", (event) => statuses.push(event.detail));
    chatSocket.connect();
    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0].open();
    assert.deepEqual(statuses, [true]);

    chatSocket.reconnect();
    assert.equal(FakeWebSocket.instances.length, 2, "resume must create exactly one fresh socket");
    assert.equal(FakeWebSocket.instances[0].readyState, FakeWebSocket.CLOSED);
    assert.deepEqual(statuses, [true, false]);
    FakeWebSocket.instances[1].open();
    assert.deepEqual(statuses, [true, false, true]);

    chatSocket.close();
    assert.equal(chatSocket.reconnectTimer, 0, "explicit close must cancel delayed reconnects");
    assert.equal(chatSocket.socket, null);
  } finally {
    globalThis.WebSocket = originalWebSocket;
    globalThis.CustomEvent = originalCustomEvent;
  }
  console.log("iOS PWA resume: interrupted boot retries and suspended WebSocket replacement verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
