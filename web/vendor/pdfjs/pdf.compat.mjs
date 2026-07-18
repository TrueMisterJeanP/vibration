// PDF.js 4 utilise ces API récentes dans le module principal et dans son worker.
// Quelques versions encore courantes de Safari et des WebView ne les exposent
// pas, ce qui empêchait tout aperçu PDF avant même la lecture du document.
if (typeof Promise.withResolvers !== "function") {
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value() {
      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    },
  });
}

if (typeof Promise.try !== "function") {
  Object.defineProperty(Promise, "try", {
    configurable: true,
    writable: true,
    value(callback, ...args) {
      return Promise.resolve().then(() => callback(...args));
    },
  });
}

if (typeof AbortSignal !== "undefined" && typeof AbortController !== "undefined"
    && typeof AbortSignal.any !== "function") {
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    writable: true,
    value(signals) {
      const controller = new AbortController();
      const listeners = [];
      const abortFrom = (signal) => {
        if (controller.signal.aborted) return;
        for (const [registeredSignal, listener] of listeners) {
          registeredSignal.removeEventListener("abort", listener);
        }
        controller.abort(signal.reason);
      };
      for (const signal of signals) {
        if (signal.aborted) {
          abortFrom(signal);
          break;
        }
        const listener = () => abortFrom(signal);
        listeners.push([signal, listener]);
        signal.addEventListener("abort", listener, { once: true });
      }
      return controller.signal;
    },
  });
}
