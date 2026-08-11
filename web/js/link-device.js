import { api } from "./api.js?v=ios17-pdf-v199";
import { locale, t } from "./i18n.js?v=conversation-search-v325";
import { frenchErrorMessage, setBusy } from "./ui.js?v=ios-resume-v297";

const introduction = document.querySelector("#link-device-introduction");
const summary = document.querySelector("#link-device-summary");
const status = document.querySelector("#link-device-status");
const approve = document.querySelector("#link-device-approve");
let approvalToken = "";

function deviceTypeLabel(kind) {
  return t(({
    desktop: "Application de bureau",
    mobile: "Téléphone",
    tablet: "Tablette",
    browser: "Navigateur web",
  })[kind] || "Appareil");
}

function formatDeadline(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function loadApprovalRequest() {
  const parameters = new URLSearchParams(location.hash.slice(1));
  approvalToken = parameters.get("token")?.trim() || "";
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  if (!approvalToken) {
    introduction.textContent = t("Ce lien de validation est incomplet ou a déjà été utilisé.");
    status.textContent = t("Recommencez la connexion sur le nouvel appareil pour obtenir un autre QR code.");
    return;
  }
  try {
    const pending = await api("/api/me/sessions/preview", {
      method: "POST",
      body: { token: approvalToken },
    });
    document.querySelector("#link-device-name").textContent = pending.device_name || t("Appareil non identifié");
    document.querySelector("#link-device-type").textContent = deviceTypeLabel(pending.device_type);
    document.querySelector("#link-device-address").textContent = pending.ip_address
      ? t("Adresse IP : {address}", { address: pending.ip_address })
      : t("Adresse IP non disponible");
    document.querySelector("#link-device-expiry").textContent = pending.approval_expires_at
      ? t("Demande valable jusqu’au {date}", { date: formatDeadline(pending.approval_expires_at) })
      : "";
    introduction.textContent = t("Vérifiez que ces informations correspondent bien à l’appareil que vous êtes en train de connecter.");
    status.textContent = t("N’autorisez jamais une demande que vous n’avez pas initiée.");
    summary.hidden = false;
    approve.hidden = false;
  } catch (error) {
    if (error.status === 401) {
      introduction.textContent = t("Ouvrez ce QR code avec un appareil déjà connecté à ce compte Vibration.");
      status.textContent = t("Vous pouvez aussi saisir le code court dans « Mon profil · Appareils et sessions » sur un appareil connecté.");
      return;
    }
    introduction.textContent = t("Cette demande n’est plus disponible.");
    status.textContent = frenchErrorMessage(error, t("Le QR code a peut-être expiré ou déjà été utilisé."));
  }
}

approve.addEventListener("click", async () => {
  setBusy(approve, true, t("Autorisation…"));
  try {
    await api("/api/me/sessions/approve", {
      method: "POST",
      body: { token: approvalToken },
    });
    approve.hidden = true;
    introduction.textContent = t("Nouvel appareil autorisé.");
    status.textContent = t("La connexion va maintenant se terminer automatiquement sur le nouvel appareil.");
  } catch (error) {
    status.textContent = frenchErrorMessage(error, t("Impossible d’autoriser cet appareil."));
  } finally {
    setBusy(approve, false);
  }
});

loadApprovalRequest();
