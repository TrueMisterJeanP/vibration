const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../web/js/i18n.js"), "utf8");
const termsSource = fs.readFileSync(path.join(__dirname, "../internal/settings/terms.go"), "utf8");

async function load(language) {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language, languages: [language] },
  });
  const moduleURL = `data:text/javascript;base64,${Buffer.from(`${source}\n// ${language}`).toString("base64")}`;
  return import(moduleURL);
}

(async () => {
  const expected = {
    en: "Sign out",
    fr: "Déconnexion",
    es: "Cerrar sesión",
    it: "Esci",
    pt: "Terminar sessão",
    de: "Abmelden",
  };

  for (const [language, label] of Object.entries(expected)) {
    const i18n = await load(`${language}-TEST`);
    assert.equal(i18n.language, language);
    assert.equal(i18n.t("Déconnexion"), label);
    assert.equal(i18n.t("Version {version}", { version: 7 }).includes("7"), true);
    assert.equal(i18n.t("{count} fichiers dans vos discussions.", { count: 3 }).includes("3"), true);
    assert.equal(i18n.t("{visible} évènements ce mois · {total} au total", { visible: 2, total: 8 }).includes("8"), true);
    assert.notEqual(i18n.t("Droits administrateur accordés"), "", true);
    assert.notEqual(i18n.translateMultiline("CONDITIONS D’UTILISATION DE VIBRATION"), "", true);
  }

  const spanish = await load("es-ES");
  assert.equal(spanish.t("{count} fichiers dans vos discussions.", { count: 3 }), "3 archivos en tus conversaciones.");
  assert.equal(spanish.t("Aucun évènement dans vos conversations."), "No hay eventos en tus conversaciones.");
  assert.equal(spanish.t("Droits administrateur accordés"), "Derechos de administrador concedidos");
  assert.equal(spanish.translateMultiline("CONDITIONS D’UTILISATION DE VIBRATION"), "CONDICIONES DE USO DE VIBRATION");
  const defaultTerms = termsSource.match(/const DefaultTermsContent = `([\s\S]*?)`/)?.[1];
  assert.ok(defaultTerms, "default terms must remain readable by the i18n test");
  const translatedTerms = spanish.translateMultiline(defaultTerms);
  assert.match(translatedTerms, /Al crear y utilizar una cuenta/);
  assert.doesNotMatch(translatedTerms, /En créant et en utilisant un compte/);
  assert.equal(translatedTerms.split("\n").length, defaultTerms.split("\n").length);

  const fallback = await load("ja-JP");
  assert.equal(fallback.language, "en");
  assert.equal(fallback.t("Connexion"), "Sign in");
  assert.equal(fallback.detectLanguage(["ja-JP", "de-DE"]), "de");
  assert.deepEqual(fallback.SUPPORTED_LANGUAGES, ["en", "fr", "es", "it", "pt", "de"]);
  console.log("i18n: 6 languages and English fallback verified");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
