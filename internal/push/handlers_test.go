package push

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"chat-pwa-go/internal/db"
)

func TestNormalizeVAPIDSubject(t *testing.T) {
	tests := map[string]string{
		"admin@example.com":               "admin@example.com",
		" mailto:admin@example.com ":      "admin@example.com",
		"MAILTO:admin@example.com":        "admin@example.com",
		"mailto:mailto:admin@example.com": "admin@example.com",
		"https://example.com/contact":     "https://example.com/contact",
		"":                                "admin@example.com",
	}

	for input, expected := range tests {
		if actual := normalizeVAPIDSubject(input); actual != expected {
			t.Errorf("normalizeVAPIDSubject(%q) = %q; want %q", input, actual, expected)
		}
	}
}

func TestSubscribeAcceptsChromeSubscriptionExpirationTime(t *testing.T) {
	database, err := db.Open(t.TempDir() + "/push.db")
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	now := "2026-07-02T00:00:00Z"
	if _, err := database.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
		VALUES(0,'push_user','Push User','hash','public','private','salt',?)`, now); err != nil {
		t.Fatal(err)
	}
	handler := &Handler{DB: database}
	body := `{"endpoint":"https://fcm.googleapis.com/fcm/send/test-endpoint","expirationTime":null,"keys":{"p256dh":"abcdefghijklmnopqrstuvwxyz","auth":"abcdefghi"}}`
	request := httptest.NewRequest(http.MethodPost, "/api/push/subscribe", strings.NewReader(body))
	response := httptest.NewRecorder()
	handler.Subscribe(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var count int
	if err := database.QueryRow(`SELECT COUNT(*) FROM push_subscriptions WHERE endpoint LIKE 'https://fcm.googleapis.com/%'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("subscription count=%d err=%v", count, err)
	}
}
