import { api } from "./api.js";

function tauriNotificationAPI() {
  return window.__TAURI__?.notification || null;
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function equalBytes(left, right) {
  if (!left || !right) return false;
  const leftBytes = left instanceof Uint8Array ? left : new Uint8Array(left);
  const rightBytes = right instanceof Uint8Array ? right : new Uint8Array(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

function browserPushSupported() {
  return !pushSupportIssue();
}

export async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  if (!["http:", "https:"].includes(location.protocol)) return null;
  return navigator.serviceWorker.register("/sw.js");
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isIOSWithoutInstalledPWA() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches
    || navigator.standalone === true;
  return isIOS && !isStandalone;
}

function pushSupportIssue() {
  if (isIOSWithoutInstalledPWA()) return "ios_requires_installed_pwa";
  if (!["http:", "https:"].includes(location.protocol)) return "unsupported_protocol";
  if (window.isSecureContext === false) return "insecure_context";
  if (!("Notification" in window)) return "notification_api_missing";
  if (!("serviceWorker" in navigator)) return "service_worker_missing";
  if (!("PushManager" in window)) return "push_manager_missing";
  return null;
}

// Start this directly from the connection/registration submit event. Some
// browsers reject permission prompts that are not tied to a user action.
export async function requestNotificationPermissionOnSignIn() {
  const native = tauriNotificationAPI();
  let nativePermission = null;
  if (native) {
    nativePermission = await native.isPermissionGranted() ? "granted" : await native.requestPermission();
  }
  if (isIOSWithoutInstalledPWA()) return Promise.resolve("default");
  if (!("Notification" in window) || !("PushManager" in window)) {
    return Promise.resolve(nativePermission || "unsupported");
  }
  if (Notification.permission !== "default") {
    return Promise.resolve(Notification.permission);
  }
  return Notification.requestPermission();
}

async function ensureNativePermission(onStatus) {
  const native = tauriNotificationAPI();
  if (!native) return null;
  onStatus("Autorisation système…");
  let granted = await native.isPermissionGranted();
  if (!granted) {
    granted = await native.requestPermission() === "granted";
  }
  if (!granted) {
    throw new Error("Notifications bloquées dans les réglages du système.");
  }
  return true;
}

function unsupportedPushError() {
  if (tauriNotificationAPI()) {
    return new Error("Les notifications natives sont locales. Pour recevoir quand l’application Android est arrêtée, ce client doit prendre en charge Web Push ou une intégration Push native Android.");
  }
  const issue = pushSupportIssue();
  if (issue === "insecure_context") {
    return new Error("Les notifications Push Android nécessitent HTTPS. Ouvrez l’application avec une adresse https:// valide, pas une adresse http:// du réseau local.");
  }
  if (issue === "ios_requires_installed_pwa") {
    return new Error("Sur iPhone ou iPad, ajoutez d’abord l’application à l’écran d’accueil, puis ouvrez-la depuis son icône.");
  }
  return new Error("Les notifications Push ne sont pas prises en charge par ce navigateur.");
}

async function ensureBrowserPushSubscription(onStatus = () => {}, options = {}) {
  const { createIfMissing = true } = options;
  if (!browserPushSupported()) throw unsupportedPushError();
  let permission = Notification.permission;
  if (permission === "default") {
    onStatus("Autorisez dans le navigateur…");
    permission = await withTimeout(
      Notification.requestPermission(),
      30000,
      "La demande d’autorisation n’a pas reçu de réponse. Vérifiez la barre d’adresse du navigateur.",
    );
  }
  if (permission === "denied") {
    throw new Error("Notifications bloquées. Autorisez-les dans les réglages du site du navigateur.");
  }
  if (permission !== "granted") {
    throw new Error("Permission de notification non accordée.");
  }

  onStatus("Initialisation…");
  const registered = await withTimeout(
    registerServiceWorker(),
    10000,
    "Le Service Worker n’a pas pu être enregistré.",
  );
  if (!registered) {
    throw new Error("Le Service Worker n’est pas disponible dans ce contexte.");
  }
  const registration = await withTimeout(
    navigator.serviceWorker.ready,
    10000,
    "Le Service Worker ne devient pas actif. Rechargez complètement la page puis réessayez.",
  );

  onStatus("Clé de notification…");
  const { public_key: publicKey } = await withTimeout(
    api("/api/push/vapid-public-key"),
    10000,
    "Le serveur ne répond pas lors de la récupération de la clé de notification.",
  );
  const applicationServerKey = urlBase64ToUint8Array(publicKey);

  onStatus("Abonnement Push…");
  let subscription = await withTimeout(
    registration.pushManager.getSubscription(),
    10000,
    "La lecture de l’abonnement Push a expiré.",
  );
  if (!subscription && !createIfMissing) return false;
  if (subscription && !equalBytes(subscription.options.applicationServerKey, applicationServerKey)) {
    onStatus("Renouvellement de l’abonnement…");
    await api("/api/push/unsubscribe", {
      method: "POST",
      body: { endpoint: subscription.endpoint },
    }).catch(() => {});
    await withTimeout(
      subscription.unsubscribe(),
      10000,
      "L’ancien abonnement Push n’a pas pu être supprimé.",
    );
    subscription = null;
  }
  if (!subscription) {
    subscription = await withTimeout(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      }),
      20000,
      "La création de l’abonnement Push a expiré. Vérifiez les permissions du navigateur.",
    );
  }

  onStatus("Enregistrement…");
  await withTimeout(
    api("/api/push/subscribe", { method: "POST", body: subscription.toJSON() }),
    10000,
    "Le serveur n’a pas enregistré l’abonnement Push.",
  );
  return subscription;
}

export async function enableNotifications(onStatus = () => {}) {
  await ensureNativePermission(onStatus);
  return ensureBrowserPushSubscription(onStatus);
}

export async function notificationStatus() {
  const native = tauriNotificationAPI();
  const nativeGranted = native ? await native.isPermissionGranted() : false;
  const pushSupported = browserPushSupported();
  let browserSubscription = false;
  let subscriptionEndpoint = "";
  if (pushSupported) {
    const registration = await registerServiceWorker();
    const subscription = await registration?.pushManager.getSubscription();
    browserSubscription = Boolean(subscription);
    subscriptionEndpoint = subscription?.endpoint || "";
  }
  const server = await api(subscriptionEndpoint
    ? `/api/push/status?endpoint=${encodeURIComponent(subscriptionEndpoint)}`
    : "/api/push/status");
  const permission = "Notification" in window
    ? Notification.permission
    : nativeGranted ? "granted" : "unsupported";
  return {
    permission,
    browserSubscription,
    serverSubscriptions: server.subscriptions || 0,
    currentDeviceServerSubscription: Boolean(server.current_subscription),
    mode: native ? "native" : "web",
    nativeGranted,
    pushSupported,
    supportIssue: pushSupportIssue(),
  };
}

export async function syncBrowserSubscription() {
  if (!browserPushSupported()) return false;
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const subscription = await ensureBrowserPushSubscription(() => {}, { createIfMissing: true });
  return Boolean(subscription);
}

export async function renewPushSubscription(onStatus = () => {}) {
  await ensureNativePermission(onStatus);
  if (!browserPushSupported()) return false;
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  onStatus("Suppression de l’ancien abonnement…");
  const registration = await registerServiceWorker();
  const current = await registration.pushManager.getSubscription();
  if (current) {
    await api("/api/push/unsubscribe", {
      method: "POST",
      body: { endpoint: current.endpoint },
    }).catch(() => {});
    await withTimeout(current.unsubscribe(), 10000, "Impossible de supprimer l’ancien abonnement.");
  }
  onStatus("Création du nouvel abonnement…");
  const { public_key: publicKey } = await api("/api/push/vapid-public-key");
  const subscription = await withTimeout(
    registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }),
    20000,
    "Impossible de renouveler l’abonnement Push.",
  );
  onStatus("Enregistrement du nouvel abonnement…");
  await api("/api/push/subscribe", { method: "POST", body: subscription.toJSON() });
  return true;
}

export async function showLocalTestNotification() {
  const native = tauriNotificationAPI();
  if (native) {
    if (!await native.isPermissionGranted()) return false;
    native.sendNotification({
      title: "Test de notification",
      body: "Les notifications natives fonctionnent dans l’application.",
    });
    return true;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return false;
  const registration = await registerServiceWorker();
  await registration.showNotification("Test de notification", {
    body: "Les notifications locales fonctionnent dans ce navigateur.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: `secure-message-local-test-${Date.now()}`,
    requireInteraction: true,
    timestamp: Date.now(),
    vibrate: [180, 80, 180],
  });
  return true;
}

export async function showIncomingMessageNotification() {
  const native = tauriNotificationAPI();
  if (native) {
    if (!document.hidden || !await native.isPermissionGranted()) return false;
    native.sendNotification({
      title: "Nouveau message sécurisé",
      body: "Ouvrez l’application pour le lire.",
    });
    return true;
  }
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return false;
  const registration = await registerServiceWorker();
  await registration.showNotification("Nouveau message sécurisé", {
    body: "Ouvrez l’application pour le lire.",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: `secure-message-${Date.now()}`,
    renotify: true,
    requireInteraction: true,
    timestamp: Date.now(),
    vibrate: [180, 80, 180],
    data: { url: "/" },
  });
  return true;
}

export async function showIncomingCallNotification(title, body) {
  const native = tauriNotificationAPI();
  if (native) {
    if (!document.hidden || !await native.isPermissionGranted()) return false;
    native.sendNotification({ title, body });
    return true;
  }
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return false;
  const registration = await registerServiceWorker();
  await registration.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "incoming-call",
    requireInteraction: true,
    data: { url: "/" },
  });
  return true;
}

export async function testNotification() {
  const status = await notificationStatus();
  if (status.browserSubscription && status.currentDeviceServerSubscription) {
    return api("/api/push/test", { method: "POST", body: {} });
  }
  return {
    subscriptions: 0,
    attempted: 0,
    sent: 0,
    removed: 0,
    failures: status.pushSupported ? ["current_device_not_subscribed"] : [status.supportIssue || (status.nativeGranted ? "native_only_no_remote_push" : "push_unavailable")],
  };
}
