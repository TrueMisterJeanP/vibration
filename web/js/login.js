import { api, clearSessionToken, getInstanceURL, hasStoredInstanceURL, isDesktopClient, normalizeInstanceURL, setInstanceURL } from "./api.js";
import {
  assessNewPassphrase,
  createIdentity,
  generateStrongPassphrase,
  NEW_PASSPHRASE_POLICY_MESSAGE,
} from "./crypto.js";
import {
  forgetTrustedDeviceCredential,
  recordSuccessfulLogin,
  signTrustedDeviceChallenge,
  trustedDeviceCredential,
} from "./device-vault.js?v=trusted-device-v300";
import {
  registerServiceWorker,
  requestNotificationPermissionOnSignIn,
} from "./notifications.js?v=community-1-0-29-v418";
import { frenchErrorMessage } from "./ui.js?v=community-1-0-29-v418";
import { t, translateMultiline } from "./i18n.js?v=community-1-0-29-v418";

const loginForm = document.querySelector("#login-form");
const instanceForm = ensureInstanceForm();
const recoveryForm = document.querySelector("#recovery-form");
const registerForm = document.querySelector("#register-form");
const invitationCodeLabel = document.querySelector("#invitation-code-label");
const loginInstanceURLLabel = document.querySelector("#login-instance-url-label");
const errorRegion = document.querySelector("#auth-error");
const loginTab = document.querySelector("#login-tab");
const registerTab = document.querySelector("#register-tab");
const registerPhraseInput = document.querySelector("#register-phrase");
const passphraseStrength = document.querySelector("#passphrase-strength");
const passphraseStrengthMeter = document.querySelector("#passphrase-strength-meter");
const generatedPassphrasePanel = document.querySelector("#generated-passphrase-panel");
const generatedPassphraseOutput = document.querySelector("#generated-passphrase");
let retryLoginAfterInstanceUpdate = false;
let registrationSettingsRequest = 0;
let termsAcceptancePromise = null;
const SHARE_RETURN_STORAGE_KEY = "vibration.file_share_return";
const invitationLinkCode = new URLSearchParams(location.search).get("invitation")?.trim().toLowerCase() || "";
const PENDING_SESSION_KEY = "vibration.pending_session_approval";
let sessionApprovalPoll = 0;

function currentDeviceMetadata() {
  const userAgent = navigator.userAgent || "";
  const platform = navigator.userAgentData?.platform || navigator.platform || "Appareil";
  const browser = /Edg\//.test(userAgent) ? "Edge"
    : /Firefox\//.test(userAgent) ? "Firefox"
      : /CriOS\//.test(userAgent) ? "Chrome"
        : /Chrome\//.test(userAgent) ? "Chrome"
          : /Safari\//.test(userAgent) ? "Safari"
            : "Vibration";
  const mobile = /Android|iPhone|iPod|Mobile/i.test(userAgent);
  const tablet = /iPad|Tablet/i.test(userAgent);
  return {
    device_name: `${browser} · ${platform}`.slice(0, 120),
    device_type: isDesktopClient() ? "desktop" : tablet ? "tablet" : mobile ? "mobile" : "browser",
  };
}

async function finishSuccessfulLogin(notificationPermission = Promise.resolve("default")) {
  if (!await ensureTermsAccepted()) {
    errorRegion.textContent = t("Vous devez accepter les conditions d’utilisation pour accéder au service.");
    return false;
  }
  const user = await api("/api/me");
  let verificationRequired = true;
  try {
    verificationRequired = await recordSuccessfulLogin(user.id);
  } catch (error) {
    // A browser may temporarily deny its local vault (private browsing,
    // storage pressure, WebKit restart). That must never invalidate a server
    // session; requiring the phrase again is the safe fallback.
    console.warn("Compteur local de vérification indisponible", error);
  }
  await notificationPermission;
  sessionStorage.removeItem("crypto_phrase");
  sessionStorage.removeItem("remember_encryption_key");
  if (verificationRequired) sessionStorage.setItem("force_identity_verification", "true");
  else sessionStorage.removeItem("force_identity_verification");
  location.href = postAuthenticationDestination();
  return true;
}

async function optionalTrustedDeviceCredential() {
  try {
    return await trustedDeviceCredential(getInstanceURL());
  } catch (error) {
    // Without a usable local signing key the server treats this browser as a
    // new device and keeps the QR/manual approval requirement.
    console.warn("Clé locale d’appareil indisponible", error);
    return {};
  }
}

function stopSessionApprovalPoll() {
  if (sessionApprovalPoll) window.clearTimeout(sessionApprovalPoll);
  sessionApprovalPoll = 0;
}

async function showSessionApproval(payload, notificationPermission = Promise.resolve("default")) {
  const dialog = document.querySelector("#session-approval-dialog");
  const status = document.querySelector("#session-approval-status");
  const qr = document.querySelector("#session-approval-qr");
  document.querySelector("#session-approval-code").textContent = payload.approval_code || "—";
  document.querySelector("#session-approval-device").textContent = currentDeviceMetadata().device_name;
  qr.hidden = !payload.qr_code;
  if (payload.qr_code) qr.src = payload.qr_code;
  status.textContent = t("En attente de l’approbation…");
  dialog.oncancel = (event) => event.preventDefault();
  if (!dialog.open) dialog.showModal();
  sessionStorage.setItem(PENDING_SESSION_KEY, JSON.stringify(payload));
  stopSessionApprovalPoll();
  const poll = async () => {
    try {
      const result = await api("/api/session/status");
      if (result.state === "approved") {
        stopSessionApprovalPoll();
        sessionStorage.removeItem(PENDING_SESSION_KEY);
        dialog.close();
        await finishSuccessfulLogin(notificationPermission);
        return;
      }
      if (result.state === "expired") {
        stopSessionApprovalPoll();
        sessionStorage.removeItem(PENDING_SESSION_KEY);
        clearSessionToken();
        status.textContent = t("La demande a expiré. Recommencez la connexion.");
        loginForm.querySelector('button[type="submit"]').disabled = false;
        return;
      }
    } catch (error) {
      if (error.status === 401) {
        stopSessionApprovalPoll();
        sessionStorage.removeItem(PENDING_SESSION_KEY);
        clearSessionToken();
        status.textContent = t("La demande n’est plus disponible. Recommencez la connexion.");
        loginForm.querySelector('button[type="submit"]').disabled = false;
        return;
      }
    }
    sessionApprovalPoll = window.setTimeout(poll, 1800);
  };
  sessionApprovalPoll = window.setTimeout(poll, 800);
}

document.querySelector("#session-approval-cancel").addEventListener("click", async () => {
  stopSessionApprovalPoll();
  try { await api("/api/session/pending", { method: "DELETE" }); } catch {}
  clearSessionToken();
  sessionStorage.removeItem(PENDING_SESSION_KEY);
  document.querySelector("#session-approval-dialog").close();
  loginForm.querySelector('button[type="submit"]').disabled = false;
});

function updatePassphraseStrength() {
  const assessment = assessNewPassphrase(registerPhraseInput.value);
  passphraseStrengthMeter.value = assessment.score;
  passphraseStrength.dataset.state = assessment.valid ? "strong" : (assessment.reason === "empty" ? "empty" : "weak");
  passphraseStrength.textContent = assessment.valid
    ? t("Phrase suffisamment robuste.")
    : t(assessment.reason === "empty" ? "Saisissez une phrase secrète." : "Phrase trop faible.");
  registerPhraseInput.setAttribute("aria-invalid", String(assessment.reason !== "empty" && !assessment.valid));
  return assessment;
}

registerPhraseInput.addEventListener("input", () => {
  if (generatedPassphraseOutput.value && registerPhraseInput.value !== generatedPassphraseOutput.value) {
    generatedPassphrasePanel.hidden = true;
  }
  updatePassphraseStrength();
});

document.querySelector("#generate-passphrase").addEventListener("click", () => {
  const phrase = generateStrongPassphrase();
  registerPhraseInput.value = phrase;
  registerForm.elements.phrase_confirm.value = phrase;
  generatedPassphraseOutput.value = phrase;
  generatedPassphrasePanel.hidden = false;
  updatePassphraseStrength();
  registerPhraseInput.focus({ preventScroll: true });
});

document.querySelector("#copy-passphrase").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(generatedPassphraseOutput.value);
    button.textContent = t("Phrase copiée.");
    setTimeout(() => { button.textContent = t("Copier la phrase"); }, 1800);
  } catch {
    generatedPassphraseOutput.focus({ preventScroll: true });
    errorRegion.textContent = t("Copie impossible. Sélectionnez la phrase affichée.");
  }
});

function postAuthenticationDestination() {
  if (new URLSearchParams(location.search).get("return_share") !== "1") return "/";
  let stored;
  try { stored = sessionStorage.getItem(SHARE_RETURN_STORAGE_KEY); } catch { return "/"; }
  if (!stored) return "/";
  try {
    const target = new URL(stored);
    if (target.origin !== location.origin || target.pathname !== "/share.html") return "/";
    try { sessionStorage.removeItem(SHARE_RETURN_STORAGE_KEY); } catch {}
    return target.toString();
  } catch {
    return "/";
  }
}

async function ensureTermsAccepted() {
  if (termsAcceptancePromise) return termsAcceptancePromise;
  termsAcceptancePromise = (async () => {
    const status = await api("/api/terms/status");
    if (status.accepted) return true;
    const dialog = document.querySelector("#terms-dialog");
    const form = document.querySelector("#terms-acceptance-form");
    const checkbox = document.querySelector("#terms-accepted");
    const error = document.querySelector("#terms-error");
    document.querySelector("#terms-content").textContent = translateMultiline(status.content || "");
    document.querySelector("#terms-version-label").textContent = t("Version {version}", { version: status.version });
    checkbox.checked = false;
    error.textContent = "";
    dialog.oncancel = (event) => event.preventDefault();
    dialog.showModal();
    document.querySelector("#terms-content").focus({ preventScroll: true });
    return new Promise((resolve) => {
      form.onsubmit = async (event) => {
        event.preventDefault();
        if (!checkbox.checked) return;
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        error.textContent = "";
        try {
          await api("/api/terms/accept", { method: "POST", body: { version: status.version, accept: true } });
          dialog.close();
          resolve(true);
        } catch (exception) {
          error.textContent = frenchErrorMessage(exception, t("Acceptation impossible."));
          button.disabled = false;
        }
      };
      document.querySelector("#terms-refuse").onclick = async () => {
        try { await api("/api/logout", { method: "POST", body: {} }); } catch {}
        dialog.close();
        resolve(false);
      };
    });
  })();
  try {
    return await termsAcceptancePromise;
  } finally {
    termsAcceptancePromise = null;
  }
}

function ensureInstanceForm() {
  const existing = document.querySelector("#instance-form");
  if (existing) return existing;
  const form = document.createElement("form");
  form.id = "instance-form";
  form.hidden = true;
  const label = document.createElement("label");
  label.textContent = t("Instance serveur");
  const input = document.createElement("input");
  input.name = "instance_url";
  input.type = "url";
  input.required = true;
  input.placeholder = "https://chat.example.com";
  input.autocomplete = "url";
  label.append(input);
  const hint = document.createElement("small");
  hint.textContent = t("L’instance enregistrée est inaccessible. Saisissez l’URL correcte pour continuer.");
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = t("Utiliser cette instance");
  form.append(label, hint, button);
  document.querySelector("#register-form")?.before(form);
  return form;
}

for (const input of document.querySelectorAll('input[name="instance_url"]')) {
  input.value = getInstanceURL();
  input.addEventListener("input", () => {
    for (const other of document.querySelectorAll('input[name="instance_url"]')) {
      if (other !== input) other.value = input.value;
    }
    if (input.form === registerForm) scheduleRegistrationSettingsLoad();
  });
}

function syncLoginInstanceField() {
  const show = isDesktopClient() || !getInstanceURL();
  loginInstanceURLLabel.hidden = !show;
  loginForm.elements.instance_url.required = show;
  if (show) loginForm.elements.instance_url.value = getInstanceURL();
}

function showTab(showRegistration) {
  syncLoginInstanceField();
  loginForm.hidden = showRegistration;
  instanceForm.hidden = true;
  recoveryForm.hidden = true;
  registerForm.hidden = !showRegistration;
  loginTab.classList.toggle("active", !showRegistration);
  registerTab.classList.toggle("active", showRegistration);
  loginTab.setAttribute("aria-selected", String(!showRegistration));
  registerTab.setAttribute("aria-selected", String(showRegistration));
  errorRegion.textContent = "";
  retryLoginAfterInstanceUpdate = false;
  if (showRegistration) loadRegistrationSettings().catch(() => {});
}

loginTab.addEventListener("click", () => showTab(false));
registerTab.addEventListener("click", () => showTab(true));

function isInstanceConnectionError(error) {
  return error?.message === "Serveur inaccessible" || /^URL d’instance /i.test(error?.message || "");
}

function showInstanceForm(message, retryLogin = false) {
  loginForm.hidden = true;
  registerForm.hidden = true;
  recoveryForm.hidden = true;
  instanceForm.hidden = false;
  retryLoginAfterInstanceUpdate = retryLogin;
  instanceForm.elements.instance_url.value = getInstanceURL();
  errorRegion.textContent = message;
  instanceForm.elements.instance_url.focus();
}

function showRecoveryForm() {
  loginForm.hidden = true;
  instanceForm.hidden = true;
  registerForm.hidden = true;
  recoveryForm.hidden = false;
  loginTab.classList.remove("active");
  registerTab.classList.remove("active");
  loginTab.setAttribute("aria-selected", "false");
  registerTab.setAttribute("aria-selected", "false");
  errorRegion.textContent = "";
  recoveryForm.elements.username.value = loginForm.elements.username.value.trim().toLowerCase();
  recoveryForm.elements.username.focus();
}

function showRecoveryCode(code) {
  const dialog = document.querySelector("#recovery-code-dialog");
  document.querySelector("#recovery-code-output").textContent = code;
  if (!dialog?.showModal) {
    alert(t("Code de récupération : {code}", { code }));
    return Promise.resolve();
  }
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
}

function setInvitationCodeRequired(required) {
  const fromInvitationLink = Boolean(invitationLinkCode);
  invitationCodeLabel.hidden = !required && !fromInvitationLink;
  registerForm.elements.invitation_code.required = required || fromInvitationLink;
  registerForm.elements.invitation_code.readOnly = fromInvitationLink;
  registerForm.elements.invitation_code.value = fromInvitationLink ? invitationLinkCode : (required ? registerForm.elements.invitation_code.value : "");
}

let registrationSettingsTimer;
function scheduleRegistrationSettingsLoad() {
  clearTimeout(registrationSettingsTimer);
  registrationSettingsTimer = setTimeout(() => {
    loadRegistrationSettings().catch(() => setInvitationCodeRequired(false));
  }, 300);
}

async function loadRegistrationSettings() {
  const requestID = ++registrationSettingsRequest;
  let baseURL;
  try {
    baseURL = normalizeInstanceURL(registerForm.elements.instance_url.value || getInstanceURL());
  } catch {
    setInvitationCodeRequired(false);
    return;
  }
  const response = await fetch(new URL("/api/registration", `${baseURL}/`).toString(), { credentials: "include" });
  if (!response.ok) throw new Error("registration settings unavailable");
  const settings = await response.json();
  if (requestID === registrationSettingsRequest) {
    setInvitationCodeRequired(Boolean(settings.invitation_code_required));
  }
}

document.querySelector("#recovery-open").addEventListener("click", showRecoveryForm);
document.querySelector("#recovery-cancel").addEventListener("click", () => showTab(false));

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const notificationPermission = requestNotificationPermissionOnSignIn().catch(() => "default");
  errorRegion.textContent = "";
  const data = Object.fromEntries(new FormData(loginForm));
  const button = loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    if (!loginInstanceURLLabel.hidden) {
      setInstanceURL(data.instance_url);
    } else if (isDesktopClient() && !hasStoredInstanceURL()) {
      throw new Error("URL d’instance requise");
    }
    const deviceCredential = await optionalTrustedDeviceCredential();
    const result = await api("/api/login", {
      method: "POST",
      body: {
        username: data.username,
        password: data.password,
        remember_me: loginForm.elements.remember_me.checked,
        desktop_client: isDesktopClient(),
        ...currentDeviceMetadata(),
        ...deviceCredential,
      },
    });
    if (result.device_proof_required && result.device_challenge) {
      try {
        const proof = await signTrustedDeviceChallenge(getInstanceURL(), result.device_challenge);
        await api("/api/session/device-proof", { method: "POST", body: proof });
        if (!await finishSuccessfulLogin(notificationPermission)) button.disabled = false;
        return;
      } catch {
        // The QR/manual approval remains available if the local key disappeared
        // between the password request and the proof.
      }
    }
    if (result.approval_required) {
      await showSessionApproval(result, notificationPermission);
      return;
    }
    if (!await finishSuccessfulLogin(notificationPermission)) button.disabled = false;
  } catch (error) {
    button.disabled = false;
    if (isInstanceConnectionError(error)) {
      showInstanceForm(t("Instance serveur inaccessible. Corrigez l’URL de l’instance pour continuer."), true);
      return;
    }
    errorRegion.textContent = frenchErrorMessage(error);
  }
});

instanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorRegion.textContent = "";
  const button = instanceForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    setInstanceURL(instanceForm.elements.instance_url.value);
    instanceForm.hidden = true;
    if (retryLoginAfterInstanceUpdate && loginForm.elements.username.value && loginForm.elements.password.value) {
      loginForm.hidden = false;
      loginForm.requestSubmit();
    } else {
      showTab(false);
    }
  } catch (error) {
    errorRegion.textContent = frenchErrorMessage(error);
  } finally {
    button.disabled = false;
  }
});

recoveryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorRegion.textContent = "";
  const data = Object.fromEntries(new FormData(recoveryForm));
  if (data.new_password !== data.confirm_password) {
    errorRegion.textContent = t("Les nouveaux mots de passe diffèrent.");
    return;
  }
  const button = recoveryForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await api("/api/password/reset", {
      method: "POST",
      body: {
        username: data.username.toLowerCase(),
        recovery_code: data.recovery_code,
        new_password: data.new_password,
      },
    });
    await forgetTrustedDeviceCredential(getInstanceURL()).catch(() => {});
    await showRecoveryCode(result.recovery_code);
    loginForm.elements.username.value = data.username.toLowerCase();
    loginForm.elements.password.value = "";
    recoveryForm.reset();
    showTab(false);
    errorRegion.textContent = t("Mot de passe réinitialisé. Vous pouvez vous connecter.");
  } catch (error) {
    if (isInstanceConnectionError(error)) {
      showInstanceForm(t("Instance serveur inaccessible. Corrigez l’URL de l’instance pour continuer."));
      return;
    }
    errorRegion.textContent = frenchErrorMessage(error);
  } finally {
    button.disabled = false;
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorRegion.textContent = "";
  const button = registerForm.querySelector('button[type="submit"]');
  const originalLabel = button.textContent;
  const data = Object.fromEntries(new FormData(registerForm));
  if (data.password !== data.password_confirm) {
    errorRegion.textContent = t("Les mots de passe de connexion diffèrent.");
    registerForm.elements.password_confirm.focus({ preventScroll: true });
    return;
  }
  if (data.phrase !== data.phrase_confirm) {
    errorRegion.textContent = t("Les phrases secrètes diffèrent.");
    registerForm.elements.phrase_confirm.focus({ preventScroll: true });
    return;
  }
  if (!assessNewPassphrase(data.phrase).valid) {
    errorRegion.textContent = t("Phrase secrète trop faible. {policy}", { policy: t(NEW_PASSPHRASE_POLICY_MESSAGE) });
    registerPhraseInput.focus({ preventScroll: true });
    return;
  }
  const notificationPermission = requestNotificationPermissionOnSignIn().catch(() => "default");
  button.disabled = true;
  button.textContent = t("Génération des clés…");
  try {
    setInstanceURL(data.instance_url);
    const identity = await createIdentity(data.phrase);
    const deviceCredential = await trustedDeviceCredential(getInstanceURL());
    const result = await api("/api/register", {
      method: "POST",
      body: {
        username: data.username.toLowerCase(),
        display_name: data.display_name,
        invitation_code: data.invitation_code,
        invitation_link: Boolean(invitationLinkCode),
        password: data.password,
        desktop_client: isDesktopClient(),
        ...currentDeviceMetadata(),
        ...deviceCredential,
        ...identity,
      },
    });
    await notificationPermission;
    await showRecoveryCode(result.recovery_code);
    if (!await ensureTermsAccepted()) {
      button.disabled = false;
      button.textContent = originalLabel;
      showTab(false);
      errorRegion.textContent = t("Compte créé. Vous devrez accepter les conditions d’utilisation lors de votre prochaine connexion.");
      return;
    }
    sessionStorage.setItem("crypto_phrase", data.phrase);
    sessionStorage.setItem("remember_encryption_key", "true");
    sessionStorage.removeItem("force_identity_verification");
    location.href = postAuthenticationDestination();
  } catch (error) {
    errorRegion.textContent = frenchErrorMessage(error);
    button.disabled = false;
    button.textContent = originalLabel;
  }
});

registerServiceWorker().catch(() => {});
syncLoginInstanceField();
if (new URLSearchParams(location.search).get("mode") === "register") showTab(true);
const storedPendingSession = sessionStorage.getItem(PENDING_SESSION_KEY);
if (storedPendingSession) {
  try { showSessionApproval(JSON.parse(storedPendingSession)).catch(() => {}); } catch { sessionStorage.removeItem(PENDING_SESSION_KEY); }
} else {
  api("/api/me").then(async () => {
    if (await ensureTermsAccepted()) location.href = postAuthenticationDestination();
  }).catch(() => {});
}
