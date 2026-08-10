const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "web", "js", "app.js"), "utf8");

assert.match(
  source,
  /if \(event\.type === "call_signal_failed"\) \{\s*await handleCallSignalFailure\(event\);\s*return;/,
  "call signalling failures must be handled before target-user filtering",
);
assert.match(
  source,
  /async function handleCallSignalFailure[\s\S]*?await clearCallState\(call\.conversationID\);[\s\S]*?signalisation/,
  "a failed private call signal must terminate the unrecoverable call explicitly",
);

console.log("call signal backpressure tests passed");
