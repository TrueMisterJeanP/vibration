const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/css/style.css"), "utf8");
const resizeStart = app.indexOf("function resizeMessageInput()");
const resizeEnd = app.indexOf("function handleMessageInput()", resizeStart);
const resizeSource = app.slice(resizeStart, resizeEnd);

assert.ok(resizeStart >= 0 && resizeEnd > resizeStart);
assert.match(app, /elements\.input\.addEventListener\("input", handleMessageInput\)/);
assert.match(app, /window\.addEventListener\("resize", resizeMessageInput\)/);
assert.match(
  css,
  /#message-input,[\s\S]*?:root\[data-theme="light"\] #message-input\s*\{[^}]*max-height:\s*8\.75rem[^}]*overflow-y:\s*hidden[^}]*resize:\s*none/,
);

const input = { scrollHeight: 76, style: {} };
const context = {
  elements: { input },
  window: { getComputedStyle: () => ({ maxHeight: "140px" }) },
};
vm.createContext(context);
vm.runInContext(`${resizeSource}\nglobalThis.resizeMessageInput = resizeMessageInput;`, context);

context.resizeMessageInput();
assert.equal(input.style.height, "76px");
assert.equal(input.style.overflowY, "hidden");

input.scrollHeight = 220;
context.resizeMessageInput();
assert.equal(input.style.height, "140px");
assert.equal(input.style.overflowY, "auto");

input.scrollHeight = 34;
context.resizeMessageInput();
assert.equal(input.style.height, "34px");
assert.equal(input.style.overflowY, "hidden");

console.log("Composer auto-resize: the message field grows with its content and remains bounded");
