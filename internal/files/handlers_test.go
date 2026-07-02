package files

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

type sentEvent struct {
	userID int64
	event  any
}

type testHub struct {
	online bool
	sent   []sentEvent
}

func (h *testHub) SendToUser(userID int64, event any) bool {
	h.sent = append(h.sent, sentEvent{userID: userID, event: event})
	return h.online
}

type testPush struct {
	users chan int64
}

func (p *testPush) NotifyUser(userID int64) {
	p.users <- userID
}

func TestUploadDownloadFileAndMarkDeliveredWhenRecipientOnline(t *testing.T) {
	db, conversationID, sender, recipient := setupFileConversation(t)
	defer db.Close()

	hub := &testHub{online: true}
	push := &testPush{users: make(chan int64, 1)}
	handler := &Handler{DB: db, Hub: hub, Push: push}
	mux := fileMux(authHandlerForTest(db), handler)

	uploaded := fileRequest(t, mux, http.MethodPost, "/api/files", uploadBody(conversationID), sender)
	if uploaded.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", uploaded.Code, uploaded.Body.String())
	}
	var uploadResponse struct {
		ID   int64 `json:"id"`
		File struct {
			ID int64 `json:"id"`
		} `json:"file"`
	}
	if err := json.Unmarshal(uploaded.Body.Bytes(), &uploadResponse); err != nil {
		t.Fatal(err)
	}
	var receiptStatus string
	if err := db.QueryRow(`SELECT status FROM message_receipts WHERE message_id=? AND user_id=2`, uploadResponse.ID).Scan(&receiptStatus); err != nil || receiptStatus != "delivered" {
		t.Fatalf("recipient receipt status=%q err=%v", receiptStatus, err)
	}
	if !hasEvent(hub.sent, 1, "message_delivered") || !hasEvent(hub.sent, 2, "new_message") {
		t.Fatalf("missing delivery events: %#v", hub.sent)
	}
	select {
	case userID := <-push.users:
		if userID != 2 {
			t.Fatalf("push recipient=%d", userID)
		}
	case <-time.After(time.Second):
		t.Fatal("push notification was not sent")
	}

	downloaded := fileRequest(t, mux, http.MethodGet, "/api/files/"+formatID(uploadResponse.File.ID), nil, recipient)
	if downloaded.Code != http.StatusOK {
		t.Fatalf("download status=%d body=%s", downloaded.Code, downloaded.Body.String())
	}
	var downloadResponse struct {
		EncryptedData string `json:"encrypted_data"`
	}
	if err := json.Unmarshal(downloaded.Body.Bytes(), &downloadResponse); err != nil {
		t.Fatal(err)
	}
	if downloadResponse.EncryptedData != base64.StdEncoding.EncodeToString([]byte("encrypted-file-data")) {
		t.Fatalf("downloaded encrypted data=%q", downloadResponse.EncryptedData)
	}
}

func TestUploadFileNotifiesPushWhenRecipientOffline(t *testing.T) {
	db, conversationID, sender, _ := setupFileConversation(t)
	defer db.Close()

	push := &testPush{users: make(chan int64, 1)}
	handler := &Handler{DB: db, Hub: &testHub{online: false}, Push: push}
	mux := fileMux(authHandlerForTest(db), handler)

	uploaded := fileRequest(t, mux, http.MethodPost, "/api/files", uploadBody(conversationID), sender)
	if uploaded.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", uploaded.Code, uploaded.Body.String())
	}
	var receiptStatus string
	if err := db.QueryRow(`SELECT status FROM message_receipts WHERE user_id=2`).Scan(&receiptStatus); err != nil || receiptStatus != "sent" {
		t.Fatalf("offline recipient receipt status=%q err=%v", receiptStatus, err)
	}
	select {
	case userID := <-push.users:
		if userID != 2 {
			t.Fatalf("push recipient=%d", userID)
		}
	case <-time.After(time.Second):
		t.Fatal("push notification was not sent")
	}
}

func TestUploadRejectsInvalidEncryptedFileMetadata(t *testing.T) {
	db, conversationID, sender, _ := setupFileConversation(t)
	defer db.Close()

	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := fileMux(authHandlerForTest(db), handler)
	body := uploadBody(conversationID)
	body["encrypted_name"] = ""
	response := fileRequest(t, mux, http.MethodPost, "/api/files", body, sender)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid metadata status=%d body=%s", response.Code, response.Body.String())
	}
}

func setupFileConversation(t *testing.T) (*sql.DB, int64, *http.Cookie, *http.Cookie) {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	authHandler := authHandlerForTest(db)
	sender := registerFileUser(t, authHandler, "file_sender")
	recipient := registerFileUser(t, authHandler, "file_recipient")
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('private',1,?)`, now)
	if err != nil {
		t.Fatal(err)
	}
	conversationID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(?,1,'ecdh-v1','owner',?),(?,2,'ecdh-v1','member',?)`, conversationID, now, conversationID, now); err != nil {
		t.Fatal(err)
	}
	return db, conversationID, sender, recipient
}

func authHandlerForTest(db *sql.DB) *auth.Handler {
	return &auth.Handler{DB: db}
}

func fileMux(authHandler *auth.Handler, handler *Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle("POST /api/files", authHandler.Middleware(http.HandlerFunc(handler.Upload)))
	mux.Handle("GET /api/files/{id}", authHandler.Middleware(http.HandlerFunc(handler.Download)))
	return mux
}

func uploadBody(conversationID int64) map[string]any {
	return map[string]any{
		"conversation_id":    conversationID,
		"encrypted_name":     "encrypted-file-name",
		"encrypted_mime":     "encrypted-file-mime",
		"encrypted_data":     base64.StdEncoding.EncodeToString([]byte("encrypted-file-data")),
		"iv":                 "file-iv-123",
		"expires_in_seconds": 0,
	}
}

func registerFileUser(t *testing.T, handler *auth.Handler, username string) *http.Cookie {
	t.Helper()
	payload := map[string]string{
		"username": username, "display_name": username, "password": "Password123!",
		"public_key":            `{"kty":"EC","x":"public-key-placeholder"}`,
		"encrypted_private_key": `{"iv":"private-iv","data":"encrypted-private-key"}`,
		"crypto_salt":           "crypto-salt-value",
	}
	data, _ := json.Marshal(payload)
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.Register(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("register %s status=%d body=%s", username, response.Code, response.Body.String())
	}
	return response.Result().Cookies()[0]
}

func fileRequest(t *testing.T, mux http.Handler, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	return response
}

func hasEvent(events []sentEvent, userID int64, eventType string) bool {
	for _, sent := range events {
		if sent.userID != userID {
			continue
		}
		event, ok := sent.event.(map[string]any)
		if ok && event["type"] == eventType {
			return true
		}
	}
	return false
}

func formatID(id int64) string {
	return strconv.FormatInt(id, 10)
}
