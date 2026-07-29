const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/login.html"), "utf8");
const login = fs.readFileSync(path.join(root, "web/js/login.js"), "utf8");
const i18n = fs.readFileSync(path.join(root, "web/js/i18n.js"), "utf8");

const registerFormStart = html.indexOf('id="register-form"');
const registerFormEnd = html.indexOf("</form>", registerFormStart);
const registerForm = html.slice(registerFormStart, registerFormEnd);
const passwordPosition = registerForm.indexOf('name="password"');
const confirmationPosition = registerForm.indexOf('name="password_confirm"');

assert.ok(registerFormStart >= 0, "the registration form must exist");
assert.ok(passwordPosition >= 0, "the sign-in password field must exist");
assert.ok(confirmationPosition > passwordPosition, "password confirmation must follow the sign-in password");
assert.match(
  registerForm,
  /Confirmer le mot de passe de connexion<input name="password_confirm" type="password" required minlength="8" maxlength="256" autocomplete="new-password">/,
);
assert.match(
  registerForm,
  /Confirmer la phrase de chiffrement<input name="phrase_confirm" type="password" required minlength="10" autocomplete="off">/,
);

const registrationHandler = login.slice(
  login.indexOf('registerForm.addEventListener("submit"'),
  login.indexOf("registerServiceWorker()"),
);
const passwordValidationPosition = registrationHandler.indexOf("data.password !== data.password_confirm");
const registrationRequestPosition = registrationHandler.indexOf('api("/api/register"');

assert.ok(passwordValidationPosition >= 0, "registration must compare both sign-in passwords");
assert.ok(
  passwordValidationPosition < registrationRequestPosition,
  "password confirmation must be checked before the registration request",
);
assert.match(registrationHandler, /t\("Les mots de passe de connexion diffèrent\."\)/);
assert.match(registrationHandler, /registerForm\.elements\.password_confirm\.focus/);
assert.match(i18n, /\["Confirmer le mot de passe de connexion", "Confirm sign-in password"/);
assert.match(i18n, /\["Confirmer la phrase de chiffrement", "Confirm encryption passphrase"/);
assert.match(i18n, /\["Les mots de passe de connexion diffèrent\.", "The sign-in passwords do not match\."/);

console.log("Registration form: sign-in password confirmation verified");
