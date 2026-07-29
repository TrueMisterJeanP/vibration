export function runKeyedTask(pendingTasks, key, task) {
  const pending = pendingTasks.get(key);
  if (pending) return pending;

  let operation;
  operation = (async () => {
    try {
      return await task();
    } finally {
      if (pendingTasks.get(key) === operation) pendingTasks.delete(key);
    }
  })();
  pendingTasks.set(key, operation);
  return operation;
}
