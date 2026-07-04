package push

import (
	"database/sql"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"chat-pwa-go/internal/auth"
	"chat-pwa-go/internal/config"
	"chat-pwa-go/internal/httpx"
	webpush "github.com/SherClockHolmes/webpush-go"
)

type Keys struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

type Handler struct {
	DB      *sql.DB
	Keys    Keys
	Subject string
}

const notificationTTLSeconds = 4 * 60 * 60

type DeliveryResult struct {
	Subscriptions int      `json:"subscriptions"`
	Attempted     int      `json:"attempted"`
	Sent          int      `json:"sent"`
	Removed       int      `json:"removed"`
	Failures      []string `json:"failures"`
}

func New(database *sql.DB, dataDir, subject string) (*Handler, error) {
	keys, err := config.LoadOrCreateJSON(filepath.Join(dataDir, "vapid.json"), func() (Keys, error) {
		privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
		return Keys{Public: publicKey, Private: privateKey}, err
	})
	if err != nil {
		return nil, err
	}
	return &Handler{DB: database, Keys: keys, Subject: normalizeVAPIDSubject(subject)}, nil
}

// webpush-go adds the mailto: scheme itself. Accepting it in configuration is
// useful for compatibility, but passing it through would produce
// "mailto:mailto:..." and Apple Push Service rejects that VAPID token.
func normalizeVAPIDSubject(subject string) string {
	subject = strings.TrimSpace(subject)
	for len(subject) >= len("mailto:") && strings.EqualFold(subject[:len("mailto:")], "mailto:") {
		subject = strings.TrimSpace(subject[len("mailto:"):])
	}
	if subject == "" {
		return "admin@example.com"
	}
	return subject
}

func (h *Handler) PublicKey(w http.ResponseWriter, _ *http.Request) {
	httpx.JSON(w, http.StatusOK, map[string]string{"public_key": h.Keys.Public})
}

func (h *Handler) Subscribe(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Endpoint       string `json:"endpoint"`
		ExpirationTime *int64 `json:"expirationTime"`
		Keys           struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if len(input.Endpoint) < 20 || len(input.Keys.P256dh) < 10 || len(input.Keys.Auth) < 5 {
		httpx.Error(w, http.StatusBadRequest, "invalid push subscription")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := h.DB.Begin()
	if err == nil {
		defer tx.Rollback()
		userID := auth.UserID(r)
		_, err = tx.Exec(`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?`, userID, input.Endpoint)
		if err == nil {
			_, err = tx.Exec(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,user_agent,created_at,updated_at)
				VALUES(?,?,?,?,?,?,?)`, userID, input.Endpoint, input.Keys.P256dh, input.Keys.Auth, r.UserAgent(), now, now)
		}
		if err == nil {
			err = tx.Commit()
		}
	}
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "subscription failed")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (h *Handler) Unsubscribe(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Endpoint string `json:"endpoint"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	_, _ = h.DB.Exec(`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?`, auth.UserID(r), input.Endpoint)
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) Test(w http.ResponseWriter, r *http.Request) {
	httpx.JSON(w, http.StatusOK, h.notify(auth.UserID(r)))
}

func (h *Handler) Status(w http.ResponseWriter, r *http.Request) {
	var count int
	userID := auth.UserID(r)
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?`, userID).Scan(&count); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "subscription lookup failed")
		return
	}
	current := false
	if endpoint := strings.TrimSpace(r.URL.Query().Get("endpoint")); endpoint != "" {
		var currentCount int
		if err := h.DB.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE user_id=? AND endpoint=?`, userID, endpoint).Scan(&currentCount); err != nil {
			httpx.Error(w, http.StatusInternalServerError, "subscription lookup failed")
			return
		}
		current = currentCount > 0
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"subscriptions": count, "current_subscription": current})
}

func (h *Handler) NotifyUser(userID int64) {
	result := h.notify(userID)
	if result.Subscriptions == 0 || len(result.Failures) > 0 {
		log.Printf("push delivery user_id=%d subscriptions=%d attempted=%d sent=%d removed=%d failures=%v",
			userID, result.Subscriptions, result.Attempted, result.Sent, result.Removed, result.Failures)
	}
}

func (h *Handler) notify(userID int64) DeliveryResult {
	result := DeliveryResult{Failures: make([]string, 0)}
	rows, err := h.DB.Query(`SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=?`, userID)
	if err != nil {
		result.Failures = append(result.Failures, "database_error")
		return result
	}
	type savedSubscription struct {
		id           int64
		subscription webpush.Subscription
	}
	var subscriptions []savedSubscription
	for rows.Next() {
		var item savedSubscription
		if rows.Scan(&item.id, &item.subscription.Endpoint, &item.subscription.Keys.P256dh, &item.subscription.Keys.Auth) == nil {
			subscriptions = append(subscriptions, item)
		}
	}
	rows.Close()
	result.Subscriptions = len(subscriptions)
	payload, _ := json.Marshal(map[string]string{
		"title": "Nouveau message",
		"body":  "Ouvrez l’application pour le lire.",
		"url":   "/",
	})
	for _, item := range subscriptions {
		result.Attempted++
		response, err := webpush.SendNotification(payload, &item.subscription, &webpush.Options{
			Subscriber: h.Subject, VAPIDPublicKey: h.Keys.Public, VAPIDPrivateKey: h.Keys.Private, TTL: notificationTTLSeconds,
		})
		if err != nil {
			result.Failures = append(result.Failures, "transport_error")
			continue
		}
		responseBody, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		response.Body.Close()
		if response.StatusCode == http.StatusGone || response.StatusCode == http.StatusNotFound {
			_, _ = h.DB.Exec(`DELETE FROM push_subscriptions WHERE id=?`, item.id)
			result.Removed++
			result.Failures = append(result.Failures, "subscription_expired")
			continue
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			result.Sent++
		} else {
			log.Printf("push service rejected subscription_id=%d status=%d body=%q", item.id, response.StatusCode, strings.TrimSpace(string(responseBody)))
			result.Failures = append(result.Failures, "push_service_http_"+http.StatusText(response.StatusCode))
		}
	}
	return result
}
