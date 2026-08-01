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
  const expectedRegistrationErrors = {
    en: ["The registration information is invalid.", "Registration is disabled.", "The activation code is invalid.", "This username is already in use.", "This display name is already in use.", "Too many attempts. Try again later.", "Registration failed.", "The password could not be secured.", "The recovery code could not be created.", "The session could not be created."],
    fr: ["Les informations d’inscription sont invalides.", "Les inscriptions sont désactivées.", "Le code d’activation est invalide.", "Ce nom d’utilisateur existe déjà.", "Ce nom affiché existe déjà.", "Trop de tentatives. Réessayez plus tard.", "L’inscription a échoué.", "La sécurisation du mot de passe a échoué.", "La création du code de récupération a échoué.", "La création de la session a échoué."],
    es: ["La información de registro no es válida.", "El registro está desactivado.", "El código de activación no es válido.", "Este nombre de usuario ya está en uso.", "Este nombre para mostrar ya está en uso.", "Demasiados intentos. Inténtalo de nuevo más tarde.", "El registro ha fallado.", "No se ha podido proteger la contraseña.", "No se ha podido crear el código de recuperación.", "No se ha podido crear la sesión."],
    it: ["Le informazioni di registrazione non sono valide.", "La registrazione è disabilitata.", "Il codice di attivazione non è valido.", "Questo nome utente è già in uso.", "Questo nome visualizzato è già in uso.", "Troppi tentativi. Riprova più tardi.", "Registrazione non riuscita.", "Impossibile proteggere la password.", "Impossibile creare il codice di recupero.", "Impossibile creare la sessione."],
    pt: ["As informações de registo são inválidas.", "O registo está desativado.", "O código de ativação é inválido.", "Este nome de utilizador já está a ser utilizado.", "Este nome apresentado já está a ser utilizado.", "Demasiadas tentativas. Tente novamente mais tarde.", "O registo falhou.", "Não foi possível proteger a palavra-passe.", "Não foi possível criar o código de recuperação.", "Não foi possível criar a sessão."],
    de: ["Die Registrierungsangaben sind ungültig.", "Die Registrierung ist deaktiviert.", "Der Aktivierungscode ist ungültig.", "Dieser Benutzername wird bereits verwendet.", "Dieser Anzeigename wird bereits verwendet.", "Zu viele Versuche. Versuchen Sie es später erneut.", "Die Registrierung ist fehlgeschlagen.", "Das Passwort konnte nicht geschützt werden.", "Der Wiederherstellungscode konnte nicht erstellt werden.", "Die Sitzung konnte nicht erstellt werden."],
  };
  const expectedQuotas = {
    en: ["File quotas", "Maximum file size (MB)", "Maximum per-user quota (GB)", "Save quotas", "File: 25 MB · User: 1 GB."],
    fr: ["Quotas de fichiers", "Taille maximale d’un fichier (Mo)", "Quota maximal par utilisateur (Go)", "Enregistrer les quotas", "Fichier : 25 Mo · Utilisateur : 1 Go."],
    es: ["Cuotas de archivos", "Tamaño máximo de un archivo (MB)", "Cuota máxima por usuario (GB)", "Guardar cuotas", "Archivo: 25 MB · Usuario: 1 GB."],
    it: ["Quote dei file", "Dimensione massima di un file (MB)", "Quota massima per utente (GB)", "Salva quote", "File: 25 MB · Utente: 1 GB."],
    pt: ["Quotas de ficheiros", "Tamanho máximo de um ficheiro (MB)", "Quota máxima por utilizador (GB)", "Guardar quotas", "Ficheiro: 25 MB · Utilizador: 1 GB."],
    de: ["Dateikontingente", "Maximale Dateigröße (MB)", "Maximales Kontingent pro Benutzer (GB)", "Kontingente speichern", "Datei: 25 MB · Benutzer: 1 GB."],
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
      i18n.t("Quotas de fichiers"),
      i18n.t("Taille maximale d’un fichier (Mo)"),
      i18n.t("Quota maximal par utilisateur (Go)"),
      i18n.t("Enregistrer les quotas"),
      i18n.t("Fichier : {file} · Utilisateur : {user}.", { file: i18n.t("{count} Mo", { count: 25 }), user: i18n.t("{count} Go", { count: 1 }) }),
    ], expectedQuotas[language]);
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
    assert.deepEqual([
      i18n.t("Les informations d’inscription sont invalides."),
      i18n.t("Les inscriptions sont désactivées."),
      i18n.t("Le code d’activation est invalide."),
      i18n.t("Ce nom d’utilisateur existe déjà."),
      i18n.t("Ce nom affiché existe déjà."),
      i18n.t("Trop de tentatives. Réessayez plus tard."),
      i18n.t("L’inscription a échoué."),
      i18n.t("La sécurisation du mot de passe a échoué."),
      i18n.t("La création du code de récupération a échoué."),
      i18n.t("La création de la session a échoué."),
    ], expectedRegistrationErrors[language]);
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
