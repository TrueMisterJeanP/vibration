import { api, getInstanceURL, hasStoredInstanceURL, isDesktopClient, normalizeInstanceURL, setInstanceURL } from "./api.js";
import { createIdentity } from "./crypto.js";
import { recordSuccessfulLogin } from "./device-vault.js";
import {
  registerServiceWorker,
  requestNotificationPermissionOnSignIn,
} from "./notifications.js";
import { frenchErrorMessage } from "./ui.js";

const loginForm = document.querySelector("#login-form");
const instanceForm = ensureInstanceForm();
const recoveryForm = document.querySelector("#recovery-form");
const registerForm = document.querySelector("#register-form");
const invitationCodeLabel = document.querySelector("#invitation-code-label");
const loginInstanceURLLabel = document.querySelector("#login-instance-url-label");
const errorRegion = document.querySelector("#auth-error");
const loginTab = document.querySelector("#login-tab");
const registerTab = document.querySelector("#register-tab");
let retryLoginAfterInstanceUpdate = false;
let registrationSettingsRequest = 0;

function ensureInstanceForm() {
  const existing = document.querySelector("#instance-form");
  if (existing) return existing;
  const form = document.createElement("form");
  form.id = "instance-form";
  form.hidden = true;
  const label = document.createElement("label");
  label.textContent = "Instance serveur";
  const input = document.createElement("input");
  input.name = "instance_url";
  input.type = "url";
  input.required = true;
  input.placeholder = "https://chat.example.com";
  input.autocomplete = "url";
  label.append(input);
  const hint = document.createElement("small");
  hint.textContent = "L’instance enregistrée est inaccessible. Saisissez l’URL correcte pour continuer.";
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Utiliser cette instance";
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
    alert(`Code de récupération : ${code}`);
    return Promise.resolve();
  }
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", resolve, { once: true }));
}

function setInvitationCodeRequired(required) {
  invitationCodeLabel.hidden = !required;
  registerForm.elements.invitation_code.required = required;
  if (!required) registerForm.elements.invitation_code.value = "";
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
    await api("/api/login", {
      method: "POST",
      body: {
        username: data.username,
        password: data.password,
        remember_me: loginForm.elements.remember_me.checked,
        desktop_client: isDesktopClient(),
      },
    });
    const user = await api("/api/me");
    const verificationRequired = await recordSuccessfulLogin(user.id);
    await notificationPermission;
    sessionStorage.removeItem("crypto_phrase");
    sessionStorage.removeItem("remember_encryption_key");
    if (verificationRequired) {
      sessionStorage.setItem("force_identity_verification", "true");
    } else {
      sessionStorage.removeItem("force_identity_verification");
    }
    location.href = "/";
  } catch (error) {
    button.disabled = false;
    if (isInstanceConnectionError(error)) {
      showInstanceForm("Instance serveur inaccessible. Corrigez l’URL de l’instance pour continuer.", true);
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
    errorRegion.textContent = "Les nouveaux mots de passe diffèrent.";
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
    await showRecoveryCode(result.recovery_code);
    loginForm.elements.username.value = data.username.toLowerCase();
    loginForm.elements.password.value = "";
    recoveryForm.reset();
    showTab(false);
    errorRegion.textContent = "Mot de passe réinitialisé. Vous pouvez vous connecter.";
  } catch (error) {
    if (isInstanceConnectionError(error)) {
      showInstanceForm("Instance serveur inaccessible. Corrigez l’URL de l’instance pour continuer.");
      return;
    }
    errorRegion.textContent = frenchErrorMessage(error);
  } finally {
    button.disabled = false;
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const notificationPermission = requestNotificationPermissionOnSignIn().catch(() => "default");
  errorRegion.textContent = "";
  const button = registerForm.querySelector('button[type="submit"]');
  const originalLabel = button.textContent;
  const data = Object.fromEntries(new FormData(registerForm));
  if (data.phrase !== data.phrase_confirm) {
    errorRegion.textContent = "Les phrases secrètes diffèrent.";
    return;
  }
  button.disabled = true;
  button.textContent = "Génération des clés…";
  try {
    setInstanceURL(data.instance_url);
    const identity = await createIdentity(data.phrase);
    const result = await api("/api/register", {
      method: "POST",
      body: {
        username: data.username.toLowerCase(),
        display_name: data.display_name,
        invitation_code: data.invitation_code,
        password: data.password,
        desktop_client: isDesktopClient(),
        ...identity,
      },
    });
    await notificationPermission;
    await showRecoveryCode(result.recovery_code);
    sessionStorage.setItem("crypto_phrase", data.phrase);
    sessionStorage.setItem("remember_encryption_key", "true");
    sessionStorage.removeItem("force_identity_verification");
    location.href = "/";
  } catch (error) {
    errorRegion.textContent = frenchErrorMessage(error);
    button.disabled = false;
    button.textContent = originalLabel;
  }
});

registerServiceWorker().catch(() => {});
syncLoginInstanceField();
api("/api/me").then(() => {
  location.href = "/";
}).catch(() => {});
