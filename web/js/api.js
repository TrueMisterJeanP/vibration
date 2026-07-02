const INSTANCE_URL_KEY = "vibration.instance_url";
const SESSION_TOKEN_KEY = "vibration.session_token";

export function isDesktopClient() {
  return Boolean(window.__TAURI__) || location.protocol === "tauri:" || location.hostname === "tauri.localhost";
}

export function normalizeInstanceURL(value) {
  value = String(value || "").trim();
  if (!value) throw new Error("URL d’instance requise");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value) ? `http://${value}` : `https://${value}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("URL d’instance invalide");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("URL d’instance invalide");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function getInstanceURL() {
  const stored = localStorage.getItem(INSTANCE_URL_KEY);
  if (stored) return stored;
  if (!isDesktopClient() && ["http:", "https:"].includes(location.protocol)) return location.origin;
  return "";
}

export function hasStoredInstanceURL() {
  return Boolean(localStorage.getItem(INSTANCE_URL_KEY));
}

export function setInstanceURL(value) {
  const normalized = normalizeInstanceURL(value);
  if (localStorage.getItem(INSTANCE_URL_KEY) !== normalized) clearSessionToken();
  localStorage.setItem(INSTANCE_URL_KEY, normalized);
  return normalized;
}

export function clearSessionToken() {
  localStorage.removeItem(SESSION_TOKEN_KEY);
}

function setSessionToken(value) {
  if (value) localStorage.setItem(SESSION_TOKEN_KEY, value);
}

function getSessionToken() {
  return localStorage.getItem(SESSION_TOKEN_KEY) || "";
}

export function apiURL(path) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const base = getInstanceURL();
  if (!base) throw new Error("URL d’instance requise");
  return new URL(path, `${base}/`).toString();
}

export function websocketURL(path = "/api/ws") {
  const url = new URL(apiURL(path));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const token = getSessionToken();
  if (token) url.searchParams.set("session_token", token);
  return url.toString();
}

export async function api(path, options = {}) {
  const config = { credentials: "include", ...options };
  const token = getSessionToken();
  if (token) config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` };
  if (config.body && !(config.body instanceof FormData) && typeof config.body !== "string") {
    config.headers = { "Content-Type": "application/json", ...(config.headers || {}) };
    config.body = JSON.stringify(config.body);
  }
  const url = apiURL(path);
  let response;
  try {
    response = await fetch(url, config);
  } catch {
    throw new Error("Serveur inaccessible");
  }
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(data?.error || `Erreur HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (data?.session_token) setSessionToken(data.session_token);
  return data;
}
