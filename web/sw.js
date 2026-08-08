const CACHE = "chat-pwa-go-v282";
const SHELL = [
  "/", "/index.html", "/login.html", "/share.html", "/css/style.css?v=passphrase-strength-v276",
  "/js/app.js?v=identity-v2", "/js/api.js?v=ios17-pdf-v199", "/js/crypto.js", "/js/websocket.js?v=ios17-pdf-v199", "/js/keyed-task-guard.js?v=ios17-pdf-v199", "/js/theme.js?v=macos-titlebar-v251",
  "/js/notifications.js?v=passphrase-strength-v276", "/js/device-vault.js", "/js/identity-trust.js?v=passphrase-strength-v276", "/js/i18n.js", "/js/ui.js?v=ios17-pdf-v211", "/js/share.js?v=ios17-pdf-v199", "/js/login.js?v=identity-v2", "/manifest.json?v=desktop-titlebar-v252",
  "/vendor/hash-wasm/argon2.umd.min.js?v=identity-v2",
  "/js/pdf-preview-compat.js?v=ios17-pdf-v199",
  "/js/conversation-cache.js?v=cache-v3",
  "/js/file-preview-image.js?v=ios17-pdf-v199",
  "/js/office-preview.js?v=office-faithful-preview-v265",
  "/vendor/pdfjs/pdf.compat.mjs?v=ios17-pdf-v199",
  "/vendor/pdfjs/pdf.min.mjs?v=ios17-pdf-v199",
  "/vendor/pdfjs/pdf.worker.compat.mjs?v=ios17-pdf-v199",
  "/vendor/pdfjs/pdf.worker.min.mjs",
  "/vendor/pdfjs-ios17/pdf.min.js?v=ios17-pdf-v199",
  "/vendor/pdfjs-ios17/pdf.worker.min.js?v=ios17-pdf-v199",
  "/vendor/jszip/jszip.min.js?v=office-preview-v254",
  "/vendor/docx-preview/docx-preview.min.js?v=office-preview-v254",
  "/vendor/exceljs/exceljs.min.js?v=office-preview-v254",
  "/vendor/pptx-preview/pptx-preview.umd.js?v=office-preview-v254",
  "/vendor/html2canvas/html2canvas.min.js?v=office-faithful-preview-v265",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/person.svg", "/icons/group.svg",
];
const OPTIONAL_SHELL = ["/admin.html", "/js/admin.js?v=admin-pagination-v267"];
const STARTUP_CACHE_PATHS = new Set(["/", "/index.html", "/css/style.css", "/js/theme.js"]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    await cache.addAll(SHELL);
    await Promise.allSettled(OPTIONAL_SHELL.map((url) => cache.add(url)));
  }));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  if (STARTUP_CACHE_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        });
      }),
    );
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((response) => response || caches.match("/index.html"))),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = { title: "Nouveau message", body: "Ouvrez l’application pour le lire.", url: "/" };
    try { payload = { ...payload, ...event.data.json() }; } catch {}
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url },
      tag: payload.tag || `secure-message-${Date.now()}`,
      renotify: true,
      requireInteraction: true,
      timestamp: Date.now(),
      vibrate: [180, 80, 180],
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const client of windows) {
      if ("focus" in client) return client.focus();
    }
    return clients.openWindow(event.notification.data?.url || "/");
  }));
});
