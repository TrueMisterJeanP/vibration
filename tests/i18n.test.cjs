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
  const expectedNotes = {
    en: ["My notes", "Personal messages and files", "1 unread message", "3 unread messages", "Personal identity not found."],
    fr: ["Mes notes", "Messages et fichiers personnels", "1 message non lu", "3 messages non lus", "Identité personnelle introuvable."],
    es: ["Mis notas", "Mensajes y archivos personales", "1 mensaje no leído", "3 mensajes no leídos", "No se encontró la identidad personal."],
    it: ["Le mie note", "Messaggi e file personali", "1 messaggio non letto", "3 messaggi non letti", "Identità personale non trovata."],
    pt: ["As minhas notas", "Mensagens e ficheiros pessoais", "1 mensagem não lida", "3 mensagens não lidas", "Identidade pessoal não encontrada."],
    de: ["Meine Notizen", "Persönliche Nachrichten und Dateien", "1 ungelesene Nachricht", "3 ungelesene Nachrichten", "Persönliche Identität nicht gefunden."],
  };
  const expectedShareErrors = {
    en: ["This shared file is unavailable.", "This shared file is no longer available.", "Unable to verify this sharing link.", "Invalid sharing key.", "The sharing key cannot decrypt this file."],
    fr: ["Ce fichier partagé n’est pas disponible.", "Ce fichier partagé n’est plus disponible.", "Impossible de vérifier ce lien de partage.", "Clé de partage invalide.", "La clé de partage ne permet pas de déchiffrer ce fichier."],
    es: ["Este archivo compartido no está disponible.", "Este archivo compartido ya no está disponible.", "No se puede verificar este enlace compartido.", "Clave de uso compartido no válida.", "La clave de uso compartido no permite descifrar este archivo."],
    it: ["Questo file condiviso non è disponibile.", "Questo file condiviso non è più disponibile.", "Impossibile verificare questo link condiviso.", "Chiave di condivisione non valida.", "La chiave di condivisione non consente di decifrare questo file."],
    pt: ["Este ficheiro partilhado não está disponível.", "Este ficheiro partilhado já não está disponível.", "Não foi possível verificar esta ligação de partilha.", "Chave de partilha inválida.", "A chave de partilha não permite desencriptar este ficheiro."],
    de: ["Diese geteilte Datei ist nicht verfügbar.", "Diese geteilte Datei ist nicht mehr verfügbar.", "Dieser Freigabelink kann nicht überprüft werden.", "Ungültiger Freigabeschlüssel.", "Der Freigabeschlüssel kann diese Datei nicht entschlüsseln."],
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
    assert.deepEqual([
      i18n.t("Mes notes"),
      i18n.t("Messages et fichiers personnels"),
      i18n.t("{count} message non lu", { count: 1 }),
      i18n.t("{count} messages non lus", { count: 3 }),
      i18n.t("Identité personnelle introuvable."),
    ], expectedNotes[language]);
    assert.deepEqual([
      i18n.t("Ce fichier partagé n’est pas disponible."),
      i18n.t("Ce fichier partagé n’est plus disponible."),
      i18n.t("Impossible de vérifier ce lien de partage."),
      i18n.t("Clé de partage invalide."),
      i18n.t("La clé de partage ne permet pas de déchiffrer ce fichier."),
    ], expectedShareErrors[language]);
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
