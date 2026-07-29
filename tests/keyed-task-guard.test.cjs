const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../web/js/keyed-task-guard.js"), "utf8");

(async () => {
  const moduleURL = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const { runKeyedTask } = await import(moduleURL);
  const pendingTasks = new Map();
  let executions = 0;
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const task = async () => {
    executions += 1;
    await wait;
    return "rendered";
  };

  const fromHTTP = runKeyedTask(pendingTasks, "12:34", task);
  const fromWebSocket = runKeyedTask(pendingTasks, "12:34", task);
  assert.strictEqual(fromWebSocket, fromHTTP);
  assert.equal(executions, 1);

  release();
  assert.deepEqual(await Promise.all([fromHTTP, fromWebSocket]), ["rendered", "rendered"]);
  assert.equal(pendingTasks.size, 0);

  await runKeyedTask(pendingTasks, "12:34", task);
  assert.equal(executions, 2);
  console.log("keyed task guard: concurrent duplicate execution prevented");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
