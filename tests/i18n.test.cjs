const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../web/js/i18n.js"), "utf8");

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
  }

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
