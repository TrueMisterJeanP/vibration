package calendar

import (
	"database/sql"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"chat-pwa-go/internal/auth"
	"golang.org/x/crypto/bcrypt"
)

type Handler struct {
	DB          *sql.DB
	AuthLimiter *auth.RateLimiter
}

type eventRow struct {
	ID        int64
	CreatedAt string
	UpdatedAt sql.NullString
	StartsAt  string
	EndsAt    string
}

func (h *Handler) Feed(w http.ResponseWriter, r *http.Request) {
	userID, ok := h.authenticate(r)
	if !ok {
		w.Header().Set("WWW-Authenticate", `Basic realm="Vibration calendar", charset="UTF-8"`)
		w.Header().Set("Cache-Control", "no-store")
		http.Error(w, "Calendar authentication required", http.StatusUnauthorized)
		return
	}

	rows, err := h.DB.Query(`SELECT m.id,m.created_at,m.updated_at,e.starts_at,e.ends_at
		FROM message_events e
		JOIN messages m ON m.id=e.message_id
		JOIN conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=? AND cm.role<>'pending'
		WHERE m.created_at>=cm.created_at
		ORDER BY e.starts_at,e.ends_at,m.id`, userID)
	if err != nil {
		http.Error(w, "Calendar unavailable", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	texts := calendarTexts(r.Header.Get("Accept-Language"))
	lines := []string{
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Vibration//Calendar Feed//EN",
		"CALSCALE:GREGORIAN",
		"METHOD:PUBLISH",
		"X-WR-CALNAME:" + escapeText("Vibration"),
	}
	for rows.Next() {
		var event eventRow
		if err := rows.Scan(&event.ID, &event.CreatedAt, &event.UpdatedAt, &event.StartsAt, &event.EndsAt); err != nil {
			http.Error(w, "Calendar unavailable", http.StatusInternalServerError)
			return
		}
		start, startOK := calendarTime(event.StartsAt)
		end, endOK := calendarTime(event.EndsAt)
		if !startOK || !endOK {
			continue
		}
		stamp := event.CreatedAt
		if event.UpdatedAt.Valid {
			stamp = event.UpdatedAt.String
		}
		stamp, stampOK := calendarTime(stamp)
		if !stampOK {
			stamp = start
		}
		lines = append(lines,
			"BEGIN:VEVENT",
			fmt.Sprintf("UID:vibration-event-%d@vibration", event.ID),
			"DTSTART:"+start,
			"DTEND:"+end,
			"DTSTAMP:"+stamp,
			"LAST-MODIFIED:"+stamp,
			"SEQUENCE:0",
			"STATUS:CONFIRMED",
			"SUMMARY:"+escapeText(texts.summary),
			"DESCRIPTION:"+escapeText(texts.description),
			"END:VEVENT",
		)
	}
	if err := rows.Err(); err != nil {
		http.Error(w, "Calendar unavailable", http.StatusInternalServerError)
		return
	}
	lines = append(lines, "END:VCALENDAR")

	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="vibration-calendar.ics"`)
	w.Header().Set("Cache-Control", "no-store, private")
	w.Header().Set("Vary", "Authorization")
	w.WriteHeader(http.StatusOK)
	for _, line := range lines {
		for _, folded := range foldLine(line) {
			_, _ = w.Write([]byte(folded + "\r\n"))
		}
	}
}

func (h *Handler) authenticate(r *http.Request) (int64, bool) {
	username, password, ok := r.BasicAuth()
	username = strings.ToLower(strings.TrimSpace(username))
	if !ok || username == "" || password == "" {
		return 0, false
	}
	if h.AuthLimiter != nil && !h.AuthLimiter.Allow("calendar:"+clientAddress(r)+":"+username) {
		return 0, false
	}
	var userID int64
	var passwordHash string
	var banned bool
	if err := h.DB.QueryRow(`SELECT id,password_hash,is_banned FROM users WHERE username=?`, username).
		Scan(&userID, &passwordHash, &banned); err != nil || banned {
		return 0, false
	}
	if bcrypt.CompareHashAndPassword([]byte(passwordHash), []byte(password)) != nil {
		return 0, false
	}
	return userID, true
}

func clientAddress(r *http.Request) string {
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func calendarTime(value string) (string, bool) {
	date, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "", false
	}
	return date.UTC().Format("20060102T150405Z"), true
}

func escapeText(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\\\")
	value = strings.ReplaceAll(value, ";", "\\;")
	value = strings.ReplaceAll(value, ",", "\\,")
	value = strings.ReplaceAll(value, "\r\n", "\\n")
	value = strings.ReplaceAll(value, "\n", "\\n")
	return strings.ReplaceAll(value, "\r", "\\n")
}

func foldLine(line string) []string {
	const maxBytes = 75
	if len([]byte(line)) <= maxBytes {
		return []string{line}
	}
	lines := make([]string, 0, 2)
	var current strings.Builder
	currentBytes := 0
	for _, character := range line {
		characterBytes := utf8.RuneLen(character)
		if currentBytes+characterBytes > maxBytes {
			lines = append(lines, current.String())
			current.Reset()
			current.WriteByte(' ')
			currentBytes = 1
		}
		current.WriteRune(character)
		currentBytes += characterBytes
	}
	if current.Len() > 0 {
		lines = append(lines, current.String())
	}
	return lines
}

type calendarText struct {
	summary     string
	description string
}

func calendarTexts(header string) calendarText {
	language := strings.ToLower(strings.TrimSpace(strings.Split(header, ",")[0]))
	if len(language) > 2 {
		language = language[:2]
	}
	switch language {
	case "fr":
		return calendarText{"Évènement Vibration", "Évènement chiffré dans Vibration. Ouvrez l’application pour consulter ses détails."}
	case "es":
		return calendarText{"Evento de Vibration", "Evento cifrado en Vibration. Abra la aplicación para consultar sus detalles."}
	case "it":
		return calendarText{"Evento Vibration", "Evento crittografato in Vibration. Apri l’applicazione per consultarne i dettagli."}
	case "pt":
		return calendarText{"Evento Vibration", "Evento encriptado no Vibration. Abra a aplicação para consultar os detalhes."}
	case "de":
		return calendarText{"Vibration-Termin", "Verschlüsselter Termin in Vibration. Öffnen Sie die Anwendung, um die Details anzuzeigen."}
	default:
		return calendarText{"Vibration event", "Encrypted event in Vibration. Open the app to view its details."}
	}
}
