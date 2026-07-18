package httpx

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
)

type ErrorBody struct {
	Error string `json:"error"`
}

func JSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func Error(w http.ResponseWriter, status int, message string) {
	JSON(w, status, ErrorBody{Error: frenchErrorMessage(status, message)})
}

func frenchErrorMessage(status int, message string) string {
	if translated, ok := map[string]string{
		"a banned user cannot become administrator": "Un utilisateur banni ne peut pas devenir administrateur.",
		"account banned":                                  "Ce compte est banni.",
		"administrator access required":                   "Un accès administrateur est requis.",
		"administrator account is protected":              "Ce compte administrateur est protégé.",
		"at least one active administrator is required":   "Au moins un administrateur actif est requis.",
		"audit failed":                                    "L’enregistrement dans le journal d’audit a échoué.",
		"audit lookup failed":                             "La consultation du journal d’audit a échoué.",
		"authentication required":                         "Authentification requise.",
		"ban update failed":                               "La mise à jour du bannissement a échoué.",
		"contact already exists":                          "Ce contact existe déjà.",
		"contact acceptance failed":                       "L’acceptation du contact a échoué.",
		"contact acceptance required":                     "Ce contact doit accepter la demande avant de pouvoir discuter.",
		"contact not found":                               "Contact introuvable.",
		"contact request not found":                       "Demande de contact introuvable.",
		"contacts lookup failed":                          "La consultation des contacts a échoué.",
		"conversation creation failed":                    "La création de la conversation a échoué.",
		"conversation deletion failed":                    "La suppression de la discussion a échoué.",
		"conversation lookup failed":                      "La consultation des conversations a échoué.",
		"conversation not found":                          "Conversation introuvable.",
		"conversation update failed":                      "La modification de la discussion a échoué.",
		"cross-site request denied":                       "La requête provenant d’un autre site a été refusée.",
		"current password is incorrect":                   "Le mot de passe actuel est incorrect.",
		"database connection failed":                      "La connexion à la base de données a échoué.",
		"database copy failed":                            "La recopie de la base de données a échoué.",
		"delete failed":                                   "La suppression a échoué.",
		"display name already exists":                     "Ce nom affiché existe déjà.",
		"encrypted file exceeds 10 MB":                    "Le fichier chiffré dépasse la limite de 10 Mo.",
		"file not found":                                  "Fichier introuvable.",
		"file share not found":                            "Lien de partage introuvable.",
		"file share unavailable":                          "Ce lien de partage a expiré ou a été désactivé.",
		"file share creation failed":                      "La création du lien de partage a échoué.",
		"file share revocation failed":                    "La désactivation du lien de partage a échoué.",
		"file share download failed":                      "Le téléchargement du fichier partagé a échoué.",
		"invalid encrypted file share":                    "Le fichier destiné au partage est invalide.",
		"invalid file share expiration":                   "La durée du partage est invalide.",
		"too many active file shares":                     "Désactivez un ancien lien avant d’en créer un nouveau.",
		"file storage failed":                             "L’enregistrement du fichier a échoué.",
		"federation base url is required":                 "L’URL publique de fédération doit être configurée sur le serveur.",
		"federation conversation creation failed":         "La création de la conversation fédérée a échoué.",
		"federation instance already exists":              "Cette instance fédérée existe déjà.",
		"federation instance is in use":                   "Cette instance fédérée est encore utilisée.",
		"federation instance not found":                   "Instance fédérée introuvable.",
		"federation instance unreachable":                 "L’instance fédérée est injoignable.",
		"federation lookup failed":                        "La consultation de la fédération a échoué.",
		"federation user lookup failed":                   "La recherche de l’utilisateur fédéré a échoué.",
		"founder administrator is protected":              "L’administrateur fondateur est protégé.",
		"group creation failed":                           "La création du groupe a échoué.",
		"invalid avatar":                                  "L’avatar est invalide.",
		"invalid description":                             "La description est invalide.",
		"invalid contact":                                 "Le contact est invalide.",
		"invalid display name":                            "Le nom affiché est invalide.",
		"invalid encrypted file":                          "Le fichier chiffré est invalide.",
		"invalid encrypted message":                       "Le message chiffré est invalide.",
		"invalid federation conversation":                 "La conversation fédérée est invalide.",
		"invalid federation instance":                     "L’instance fédérée est invalide.",
		"invalid federation message":                      "Le message fédéré est invalide.",
		"invalid federation poll":                         "Le sondage fédéré est invalide.",
		"invalid federation poll vote":                    "Le vote fédéré est invalide.",
		"invalid federation signature":                    "La signature de fédération est invalide.",
		"invalid group":                                   "Le groupe est invalide.",
		"invalid invitation code":                         "Le code d’activation est invalide.",
		"invalid JSON body":                               "Les données envoyées sont invalides.",
		"invalid member":                                  "Le membre est invalide.",
		"invalid message expiration":                      "La durée d’expiration du message est invalide.",
		"invalid reaction":                                "La réaction est invalide.",
		"invalid new password":                            "Le nouveau mot de passe est invalide.",
		"invalid origin":                                  "L’origine de la requête est invalide.",
		"invalid password reset request":                  "La demande de réinitialisation est invalide.",
		"invalid participant":                             "Le participant est invalide.",
		"invalid push subscription":                       "L’abonnement aux notifications Push est invalide.",
		"invalid poll":                                    "Le sondage est invalide.",
		"invalid registration fields":                     "Les informations d’inscription sont invalides.",
		"invalid recovery code":                           "Le code de récupération est invalide.",
		"invalid role":                                    "Le rôle est invalide.",
		"invalid username":                                "Le nom d’utilisateur est invalide.",
		"invalid username or password":                    "Nom d’utilisateur ou mot de passe incorrect.",
		"member already exists":                           "Ce membre appartient déjà au groupe.",
		"member cannot be removed":                        "Ce membre ne peut pas être retiré.",
		"member not found":                                "Membre introuvable.",
		"member removal failed":                           "Le retrait du membre a échoué.",
		"manager role cannot be assigned":                 "Le rôle gestionnaire ne peut pas être attribué à ce compte.",
		"members lookup failed":                           "La consultation des membres a échoué.",
		"message creation failed":                         "La création du message a échoué.",
		"message lookup failed":                           "La consultation des messages a échoué.",
		"message metadata lookup failed":                  "La consultation des informations du message a échoué.",
		"message moderation failed":                       "La modération du message a échoué.",
		"message not found":                               "Message introuvable.",
		"message pin update failed":                       "La mise à jour de l’épinglage a échoué.",
		"message update failed":                           "La modification du message a échoué.",
		"poll already voted":                              "Vous avez déjà voté à ce sondage.",
		"poll creation failed":                            "La création du sondage a échoué.",
		"poll not found":                                  "Sondage introuvable.",
		"poll update failed":                              "La modification du sondage a échoué.",
		"poll vote failed":                                "L’enregistrement du vote a échoué.",
		"method not allowed":                              "Méthode non autorisée.",
		"missing encrypted group key":                     "La clé chiffrée du groupe est manquante.",
		"only the group owner can add members":            "Seul le propriétaire du groupe peut ajouter des membres.",
		"only the group owner can edit the group":         "Seul le propriétaire du groupe peut modifier ce groupe.",
		"password hashing failed":                         "La sécurisation du mot de passe a échoué.",
		"password reset failed":                           "La réinitialisation du mot de passe a échoué.",
		"reason is too long":                              "Le motif est trop long.",
		"receipt creation failed":                         "La création de l’accusé de réception a échoué.",
		"receipt update failed":                           "La mise à jour de l’accusé de réception a échoué.",
		"reaction update failed":                          "La mise à jour de la réaction a échoué.",
		"recovery code creation failed":                   "La création du code de récupération a échoué.",
		"recovery code update failed":                     "La mise à jour du code de récupération a échoué.",
		"registration disabled":                           "Les inscriptions sont désactivées.",
		"registration failed":                             "L’inscription a échoué.",
		"role update failed":                              "La mise à jour du rôle a échoué.",
		"remote user sync failed":                         "La synchronisation de l’utilisateur distant a échoué.",
		"search failed":                                   "La recherche a échoué.",
		"session creation failed":                         "La création de la session a échoué.",
		"session expired":                                 "La session a expiré.",
		"session lookup failed":                           "La consultation de la session a échoué.",
		"session revocation failed":                       "La révocation de la session a échoué.",
		"settings lookup failed":                          "La consultation de la configuration a échoué.",
		"settings update failed":                          "La mise à jour de la configuration a échoué.",
		"subscription failed":                             "L’enregistrement de l’abonnement a échoué.",
		"subscription lookup failed":                      "La consultation de l’abonnement a échoué.",
		"terms acceptance failed":                         "L’acceptation des conditions d’utilisation a échoué.",
		"terms acceptance required":                       "Vous devez accepter les conditions d’utilisation pour continuer.",
		"terms lookup failed":                             "La consultation des conditions d’utilisation a échoué.",
		"current terms must be accepted":                  "Vous devez accepter la version actuelle des conditions d’utilisation.",
		"invalid terms content":                           "Le texte des conditions d’utilisation est invalide.",
		"the last active administrator cannot be banned":  "Le dernier administrateur actif ne peut pas être banni.",
		"the last active administrator cannot be deleted": "Le dernier administrateur actif ne peut pas être supprimé.",
		"too many authentication attempts":                "Trop de tentatives. Réessayez plus tard.",
		"upload commit failed":                            "La validation de l’envoi du fichier a échoué.",
		"upload failed":                                   "L’envoi du fichier a échoué.",
		"user lookup failed":                              "La consultation des utilisateurs a échoué.",
		"user deletion failed":                            "La suppression du membre a échoué.",
		"user not found":                                  "Utilisateur introuvable.",
		"username already exists":                         "Ce nom d’utilisateur existe déjà.",
		"you cannot ban your own account":                 "Vous ne pouvez pas bannir votre propre compte.",
		"you cannot delete your own account":              "Vous ne pouvez pas supprimer votre propre compte.",
	}[message]; ok {
		return translated
	}
	switch status {
	case http.StatusBadRequest:
		return "La requête est invalide."
	case http.StatusUnauthorized:
		return "Authentification requise."
	case http.StatusForbidden:
		return "Accès refusé."
	case http.StatusNotFound:
		return "Ressource introuvable."
	case http.StatusConflict:
		return "Cette opération entre en conflit avec les données existantes."
	case http.StatusRequestEntityTooLarge:
		return "Les données envoyées sont trop volumineuses."
	case http.StatusTooManyRequests:
		return "Trop de requêtes. Réessayez plus tard."
	default:
		return "Une erreur interne est survenue."
	}
}

func Decode(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 24<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		Error(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		Error(w, http.StatusBadRequest, "invalid JSON body")
		return false
	}
	return true
}

func PathID(r *http.Request, name string) (int64, error) {
	value := strings.TrimSpace(r.PathValue(name))
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return 0, errors.New("invalid id")
	}
	return id, nil
}

func Method(handler http.HandlerFunc, method string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != method {
			w.Header().Set("Allow", method)
			Error(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		handler(w, r)
	}
}
