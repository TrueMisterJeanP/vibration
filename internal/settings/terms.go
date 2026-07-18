package settings

import (
	"database/sql"
	"strconv"
	"strings"
	"time"
)

const (
	TermsContentKey = "terms_content"
	TermsVersionKey = "terms_version"
)

const DefaultTermsContent = `CONDITIONS D’UTILISATION DE VIBRATION

En créant et en utilisant un compte, vous vous engagez à respecter les autres utilisateurs, la loi applicable et les règles de cette instance.

Sont notamment interdits :
• le harcèlement, les menaces, l’intimidation, les insultes répétées et les appels à la haine ;
• la diffusion de contenus illégaux, violents, discriminatoires, pédopornographiques ou faisant l’apologie d’activités criminelles ;
• l’usurpation d’identité, la fraude, l’escroquerie, le hameçonnage et toute tentative de manipulation ;
• le spam, la publicité non sollicitée, les envois automatisés abusifs et la perturbation volontaire du service ;
• le partage de logiciels malveillants, de liens dangereux ou toute tentative d’accès non autorisé à un compte, un appareil ou un serveur ;
• la publication ou le partage de données personnelles d’un tiers sans son autorisation ;
• l’utilisation du service pour contourner une mesure de modération ou pour organiser des abus.

En cas de signalement ou de constat d’un abus, l’administration peut supprimer les contenus concernés, limiter l’accès au service, révoquer les sessions ou bannir temporairement ou définitivement le compte. Les faits susceptibles de constituer une infraction peuvent être signalés aux autorités compétentes conformément à la loi.

Vous êtes responsable de la sécurité de votre mot de passe, de votre phrase secrète et de votre code de récupération. Le chiffrement de bout en bout empêche l’administration de lire le contenu chiffré de vos conversations, mais ne dispense pas chaque utilisateur de respecter les présentes conditions.

En cochant la case d’acceptation, vous confirmez avoir lu et accepté ces conditions d’utilisation.`

type Terms struct {
	Content   string `json:"content"`
	Version   int64  `json:"version"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

func LoadTerms(db *sql.DB) (Terms, error) {
	result := Terms{Content: DefaultTermsContent, Version: 1}
	var versionRaw string
	var contentUpdated, versionUpdated string
	contentErr := db.QueryRow("SELECT value,updated_at FROM app_settings WHERE `key`=?", TermsContentKey).Scan(&result.Content, &contentUpdated)
	if contentErr != nil && contentErr != sql.ErrNoRows {
		return Terms{}, contentErr
	}
	versionErr := db.QueryRow("SELECT value,updated_at FROM app_settings WHERE `key`=?", TermsVersionKey).Scan(&versionRaw, &versionUpdated)
	if versionErr != nil && versionErr != sql.ErrNoRows {
		return Terms{}, versionErr
	}
	if parsed, err := strconv.ParseInt(versionRaw, 10, 64); err == nil && parsed > 0 {
		result.Version = parsed
	}
	if contentUpdated > versionUpdated {
		result.UpdatedAt = contentUpdated
	} else {
		result.UpdatedAt = versionUpdated
	}
	return result, nil
}

func SaveTerms(db *sql.DB, content string) (Terms, bool, error) {
	content = strings.TrimSpace(content)
	current, err := LoadTerms(db)
	if err != nil {
		return Terms{}, false, err
	}
	if content == current.Content {
		return current, false, nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	next := Terms{Content: content, Version: current.Version + 1, UpdatedAt: now}
	tx, err := db.Begin()
	if err != nil {
		return Terms{}, false, err
	}
	defer tx.Rollback()
	for key, value := range map[string]string{TermsContentKey: next.Content, TermsVersionKey: strconv.FormatInt(next.Version, 10)} {
		if _, err := tx.Exec("DELETE FROM app_settings WHERE `key`=?", key); err != nil {
			return Terms{}, false, err
		}
		if _, err := tx.Exec("INSERT INTO app_settings(`key`,value,updated_at) VALUES(?,?,?)", key, value, now); err != nil {
			return Terms{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Terms{}, false, err
	}
	return next, true, nil
}

func TermsAccepted(db *sql.DB, userID, version int64) (bool, error) {
	var acceptedVersion int64
	err := db.QueryRow(`SELECT version FROM user_terms_acceptances WHERE user_id=?`, userID).Scan(&acceptedVersion)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil && acceptedVersion >= version, err
}

func AcceptTerms(db *sql.DB, userID, version int64) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM user_terms_acceptances WHERE user_id=?`, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO user_terms_acceptances(user_id,version,accepted_at) VALUES(?,?,?)`, userID, version, now); err != nil {
		return err
	}
	return tx.Commit()
}
