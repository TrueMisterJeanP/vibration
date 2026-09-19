package main

import (
	"strconv"
	"strings"
)

type errorPageTranslation struct {
	title       string
	tagline     string
	statusLabel string
	ariaLabel   string
	heading     string
	messageHTML string
	asideHTML   string
	action      string
}

var errorPageTranslations = map[int]map[string]errorPageTranslation{
	404: {
		"fr": {
			title:       "404 — Mauvaise pioche",
			tagline:     "Messagerie chiffrée de bout en bout",
			statusLabel: "Page introuvable",
			ariaLabel:   "Erreur 404",
			heading:     "Bien essayé, Sherlock.",
			messageHTML: "Cette porte n’existe pas. Ton scanner automatique vient surtout de découvrir une magnifique page d’erreur.",
			asideHTML:   "Visiteur égaré&nbsp;? Aucun souci, la vraie entrée est juste en dessous.",
			action:      "Retour à l’accueil",
		},
		"en": {
			title:       "404 — Wrong turn",
			tagline:     "End-to-end encrypted messaging",
			statusLabel: "Page not found",
			ariaLabel:   "Error 404",
			heading:     "Nice try, Sherlock.",
			messageHTML: "This door does not exist. Your automated scanner has mostly discovered a magnificent error page.",
			asideHTML:   "Lost visitor? No worries, the real entrance is just below.",
			action:      "Back to home",
		},
		"es": {
			title:       "404 — Camino equivocado",
			tagline:     "Mensajería cifrada de extremo a extremo",
			statusLabel: "Página no encontrada",
			ariaLabel:   "Error 404",
			heading:     "Buen intento, Sherlock.",
			messageHTML: "Esta puerta no existe. Tu escáner automático acaba de descubrir, sobre todo, una magnífica página de error.",
			asideHTML:   "¿Visitante perdido? No pasa nada, la entrada correcta está justo debajo.",
			action:      "Volver al inicio",
		},
		"it": {
			title:       "404 — Strada sbagliata",
			tagline:     "Messaggistica crittografata end-to-end",
			statusLabel: "Pagina non trovata",
			ariaLabel:   "Errore 404",
			heading:     "Bel tentativo, Sherlock.",
			messageHTML: "Questa porta non esiste. Il tuo scanner automatico ha soprattutto scoperto una magnifica pagina di errore.",
			asideHTML:   "Visitatore smarrito? Nessun problema, l’ingresso giusto è qui sotto.",
			action:      "Torna alla home",
		},
		"pt": {
			title:       "404 — Caminho errado",
			tagline:     "Mensagens com encriptação ponto a ponto",
			statusLabel: "Página não encontrada",
			ariaLabel:   "Erro 404",
			heading:     "Boa tentativa, Sherlock.",
			messageHTML: "Esta porta não existe. O seu scanner automático acabou sobretudo por descobrir uma magnífica página de erro.",
			asideHTML:   "Visitante perdido? Sem problema, a entrada certa está logo abaixo.",
			action:      "Voltar ao início",
		},
		"de": {
			title:       "404 — Falsch abgebogen",
			tagline:     "Ende-zu-Ende-verschlüsselte Kommunikation",
			statusLabel: "Seite nicht gefunden",
			ariaLabel:   "Fehler 404",
			heading:     "Netter Versuch, Sherlock.",
			messageHTML: "Diese Tür gibt es nicht. Ihr automatischer Scanner hat vor allem eine großartige Fehlerseite entdeckt.",
			asideHTML:   "Verirrt? Kein Problem, der richtige Eingang ist gleich hier unten.",
			action:      "Zur Startseite",
		},
	},
	429: {
		"fr": {
			title:       "429 — Au coin",
			tagline:     "Messagerie chiffrée de bout en bout",
			statusLabel: "Trop de requêtes",
			ariaLabel:   "Erreur 429",
			heading:     "Trois fausses portes. Joli score.",
			messageHTML: "L’accès est temporairement bloqué pendant <strong>dix minutes</strong>. Vous pourrez ensuite réessayer normalement.",
		},
		"en": {
			title:       "429 — Time out",
			tagline:     "End-to-end encrypted messaging",
			statusLabel: "Too many requests",
			ariaLabel:   "Error 429",
			heading:     "Three wrong doors. Nice score.",
			messageHTML: "Access is temporarily blocked for <strong>ten minutes</strong>. You can then try again normally.",
		},
		"es": {
			title:       "429 — Tiempo de espera",
			tagline:     "Mensajería cifrada de extremo a extremo",
			statusLabel: "Demasiadas solicitudes",
			ariaLabel:   "Error 429",
			heading:     "Tres puertas equivocadas. Buena puntuación.",
			messageHTML: "El acceso está bloqueado temporalmente durante <strong>diez minutos</strong>. Después podrás volver a intentarlo con normalidad.",
		},
		"it": {
			title:       "429 — In pausa",
			tagline:     "Messaggistica crittografata end-to-end",
			statusLabel: "Troppe richieste",
			ariaLabel:   "Errore 429",
			heading:     "Tre porte sbagliate. Bel punteggio.",
			messageHTML: "L’accesso è temporaneamente bloccato per <strong>dieci minuti</strong>. In seguito potrai riprovare normalmente.",
		},
		"pt": {
			title:       "429 — Tempo de espera",
			tagline:     "Mensagens com encriptação ponto a ponto",
			statusLabel: "Demasiados pedidos",
			ariaLabel:   "Erro 429",
			heading:     "Três portas erradas. Bela pontuação.",
			messageHTML: "O acesso está temporariamente bloqueado durante <strong>dez minutos</strong>. Depois poderá tentar novamente normalmente.",
		},
		"de": {
			title:       "429 — Auszeit",
			tagline:     "Ende-zu-Ende-verschlüsselte Kommunikation",
			statusLabel: "Zu viele Anfragen",
			ariaLabel:   "Fehler 429",
			heading:     "Drei falsche Türen. Gute Punktzahl.",
			messageHTML: "Der Zugriff ist für <strong>zehn Minuten</strong> vorübergehend gesperrt. Danach können Sie es wieder normal versuchen.",
		},
	},
}

func localizeErrorPage(status int, source []byte) map[string][]byte {
	translations := errorPageTranslations[status]
	base, ok := translations["fr"]
	if !ok || len(source) == 0 {
		return nil
	}

	localized := make(map[string][]byte, len(translations))
	for language, translation := range translations {
		replacements := []string{
			`<html lang="fr">`, `<html lang="` + language + `">`,
			`<title>` + base.title + `</title>`, `<title>` + translation.title + `</title>`,
			`<div><strong>Vibration</strong><small>` + base.tagline + `</small></div>`, `<div><strong>Vibration</strong><small>` + translation.tagline + `</small></div>`,
			`<p class="status">` + base.statusLabel + `</p>`, `<p class="status">` + translation.statusLabel + `</p>`,
			`aria-label="` + base.ariaLabel + `"`, `aria-label="` + translation.ariaLabel + `"`,
			`<h1>` + base.heading + `</h1>`, `<h1>` + translation.heading + `</h1>`,
			`<p>` + base.messageHTML + `</p>`, `<p>` + translation.messageHTML + `</p>`,
		}
		if base.asideHTML != "" {
			replacements = append(replacements,
				`<p class="aside">`+base.asideHTML+`</p>`, `<p class="aside">`+translation.asideHTML+`</p>`,
				`<a href="/">`+base.action+`</a>`, `<a href="/">`+translation.action+`</a>`,
			)
		}
		localized[language] = []byte(strings.NewReplacer(replacements...).Replace(string(source)))
	}
	return localized
}

func preferredErrorLanguage(header string) string {
	bestLanguage := "fr"
	bestQuality := -1.0
	for _, candidate := range strings.Split(header, ",") {
		parts := strings.Split(candidate, ";")
		tag := strings.ToLower(strings.TrimSpace(parts[0]))
		if tag == "" || tag == "*" {
			continue
		}
		language := strings.Split(strings.ReplaceAll(tag, "_", "-"), "-")[0]
		if _, supported := errorPageTranslations[404][language]; !supported {
			continue
		}

		quality := 1.0
		for _, parameter := range parts[1:] {
			name, value, found := strings.Cut(strings.TrimSpace(parameter), "=")
			if !found || !strings.EqualFold(name, "q") {
				continue
			}
			parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err != nil {
				quality = 0
			} else {
				quality = parsed
			}
		}
		if quality > 0 && quality > bestQuality {
			bestLanguage = language
			bestQuality = quality
		}
	}
	return bestLanguage
}
