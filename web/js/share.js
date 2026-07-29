import { decryptBytes, decryptEnvelope, importShareKey } from "./crypto.js?v=ios17-pdf-v184";
import { locale, localizeDocument, t } from "./i18n.js";

localizeDocument();

const RETURN_STORAGE_KEY = "vibration.file_share_return";
const elements = {
  name: document.querySelector("#share-file-name"),
  meta: document.querySelector("#share-file-meta"),
  expiry: document.querySelector("#share-file-expiry"),
  status: document.querySelector("#share-file-status"),
  error: document.querySelector("#share-error"),
  download: document.querySelector("#share-download-button"),
  login: document.querySelector("#share-login-link"),
  register: document.querySelector("#share-register-link"),
};

let token = "";
let shareKey = null;
let fileName = "Fichier partagé";
let fileMIME = "application/octet-stream";
let downloading = false;

const serverShareErrors = new Map([
  ["file share not found", "Ce fichier partagé n’est pas disponible."],
  ["file share unavailable", "Ce fichier partagé n’est plus disponible."],
  ["file share lookup failed", "Impossible de vérifier ce lien de partage."],
  ["file share download failed", "Téléchargement impossible."],
]);

class SharePageError extends Error {
  constructor(source) {
    super(source);
    this.source = source;
  }
}

function localizedShareError(error, fallback) {
  if (error instanceof SharePageError) return t(error.source);
  if (error?.message === "Clé de partage invalide.") return t("Clé de partage invalide.");
  if (["DataError", "InvalidCharacterError", "OperationError", "SyntaxError"].includes(error?.name)) {
    return t("La clé de partage ne permet pas de déchiffrer ce fichier.");
  }
  return t(fallback);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
}

function safeMIME(value) {
  const mime = String(value || "").trim().toLowerCase().split(";")[0];
  return /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : "application/octet-stream";
}

async function responseJSON(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new SharePageError(serverShareErrors.get(data.error) || "Ce fichier partagé n’est pas disponible.");
  }
  return data;
}

async function downloadSharedFile(automatic = false) {
  if (downloading || !shareKey || !token) return;
  downloading = true;
  elements.download.disabled = true;
  elements.status.textContent = t(automatic ? "Téléchargement automatique…" : "Préparation du téléchargement…");
  try {
    const response = await fetch(`/api/file-shares/${encodeURIComponent(token)}/download`, {
      credentials: "include",
      cache: "no-store",
    });
    const payload = await responseJSON(response);
    const clear = await decryptBytes(shareKey, payload.encrypted_data, payload.iv);
    const url = URL.createObjectURL(new Blob([clear], { type: fileMIME }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    elements.status.textContent = t("Téléchargement démarré.");
  } catch (error) {
    elements.status.textContent = "";
    elements.error.textContent = localizedShareError(error, "Téléchargement impossible.");
  } finally {
    downloading = false;
    elements.download.disabled = false;
  }
}

async function init() {
  try { sessionStorage.setItem(RETURN_STORAGE_KEY, location.href); } catch {}
  token = new URLSearchParams(location.search).get("token") || "";
  const exportedKey = new URLSearchParams(location.hash.slice(1)).get("key") || "";
  if (!token || !exportedKey) throw new SharePageError("Ce lien de partage est incomplet.");
  shareKey = await importShareKey(exportedKey);
  const response = await fetch(`/api/file-shares/${encodeURIComponent(token)}`, {
    credentials: "include",
    cache: "no-store",
  });
  const metadata = await responseJSON(response);
  [fileName, fileMIME] = await Promise.all([
    decryptEnvelope(shareKey, metadata.encrypted_name),
    decryptEnvelope(shareKey, metadata.encrypted_mime),
  ]);
  fileMIME = safeMIME(fileMIME);
  elements.name.textContent = fileName;
  elements.meta.textContent = `${formatSize(metadata.size)} · ${fileMIME}`;
  elements.expiry.textContent = t("Lien valable jusqu’au {date}.", { date: new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(new Date(metadata.expires_at)) });
  elements.download.setAttribute("aria-label", t("Télécharger {name}", { name: fileName }));
  elements.download.disabled = false;
  elements.download.addEventListener("click", () => downloadSharedFile(false));

  const session = await fetch("/api/me", { credentials: "include", cache: "no-store" }).catch(() => null);
  if (session?.ok) {
    document.querySelector(".share-auth-actions").hidden = true;
    elements.status.textContent = t("Session reconnue. Le téléchargement va démarrer.");
    await downloadSharedFile(true);
  }
}

init().catch((error) => {
  elements.name.textContent = t("Fichier indisponible");
  elements.meta.textContent = "";
  elements.expiry.textContent = "";
  elements.status.textContent = "";
  elements.error.textContent = localizedShareError(error, "Impossible d’ouvrir ce lien de partage.");
  elements.download.disabled = true;
});
