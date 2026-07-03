const CACHE = "chat-pwa-go-v140";
const SHELL = [
  "/", "/index.html", "/login.html", "/css/style.css",
  "/js/app.js", "/js/api.js", "/js/crypto.js", "/js/websocket.js", "/js/theme.js",
  "/js/notifications.js", "/js/device-vault.js", "/js/ui.js", "/js/login.js", "/manifest.json",
  "/vendor/pdfjs/pdf.min.mjs", "/vendor/pdfjs/pdf.worker.min.mjs",
  "/icons/icon-192.png", "/icons/icon-512.png", "/icons/person.svg", "/icons/group.svg",
];
const OPTIONAL_SHELL = ["/admin.html", "/js/admin.js"];

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
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) return;
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
    let payload = { title: "Nouveau message sécurisé", body: "Ouvrez l’application pour le lire.", url: "/" };
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
