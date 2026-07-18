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

	listed := fileRequest(t, mux, http.MethodGet, "/api/files", nil, recipient)
	if listed.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
	var listedMessages []listedFileMessage
	if err := json.Unmarshal(listed.Body.Bytes(), &listedMessages); err != nil {
		t.Fatal(err)
	}
	if len(listedMessages) != 1 || listedMessages[0].ID != uploadResponse.ID || listedMessages[0].File == nil ||
		listedMessages[0].File.ID != uploadResponse.File.ID || listedMessages[0].ConversationID != conversationID {
		t.Fatalf("listed files=%+v", listedMessages)
	}
	outsider := registerFileUser(t, authHandlerForTest(db), "file_outsider")
	outsiderList := fileRequest(t, mux, http.MethodGet, "/api/files", nil, outsider)
	if outsiderList.Code != http.StatusOK {
		t.Fatalf("outsider list status=%d body=%s", outsiderList.Code, outsiderList.Body.String())
	}
	listedMessages = nil
	if err := json.Unmarshal(outsiderList.Body.Bytes(), &listedMessages); err != nil || len(listedMessages) != 0 {
		t.Fatalf("outsider files=%+v err=%v", listedMessages, err)
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

func TestFileShareIsPublicEncryptedCountedAndRevocableByCreator(t *testing.T) {
	db, conversationID, sender, recipient := setupFileConversation(t)
	defer db.Close()

	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := fileMux(authHandlerForTest(db), handler)
	uploaded := fileRequest(t, mux, http.MethodPost, "/api/files", uploadBody(conversationID), sender)
	if uploaded.Code != http.StatusCreated {
		t.Fatalf("upload status=%d body=%s", uploaded.Code, uploaded.Body.String())
	}
	var uploadedFile struct {
		File struct {
			ID int64 `json:"id"`
		} `json:"file"`
	}
	if err := json.Unmarshal(uploaded.Body.Bytes(), &uploadedFile); err != nil {
		t.Fatal(err)
	}
	shareData := bytes.Repeat([]byte{7}, 20)
	shareBody := map[string]any{
		"encrypted_name":     `{"iv":"share-name-iv","data":"share-name-data"}`,
		"encrypted_mime":     `{"iv":"share-mime-iv","data":"share-mime-data"}`,
		"encrypted_data":     base64.StdEncoding.EncodeToString(shareData),
		"iv":                 "share-data-iv",
		"size":               4,
		"expires_in_seconds": 3600,
	}
	created := fileRequest(t, mux, http.MethodPost, "/api/files/"+formatID(uploadedFile.File.ID)+"/shares", shareBody, recipient)
	if created.Code != http.StatusCreated {
		t.Fatalf("share create status=%d body=%s", created.Code, created.Body.String())
	}
	var share struct {
		ID    int64  `json:"id"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &share); err != nil || len(share.Token) != 43 {
		t.Fatalf("share=%+v err=%v", share, err)
	}
	var storedToken string
	if err := db.QueryRow(`SELECT token_hash FROM file_shares WHERE id=?`, share.ID).Scan(&storedToken); err != nil {
		t.Fatal(err)
	}
	if storedToken == share.Token || len(storedToken) != 64 {
		t.Fatalf("stored token hash=%q", storedToken)
	}
	listed := fileRequest(t, mux, http.MethodGet, "/api/files/"+formatID(uploadedFile.File.ID)+"/shares", nil, recipient)
	if listed.Code != http.StatusOK || !bytes.Contains(listed.Body.Bytes(), []byte(`"active":true`)) {
		t.Fatalf("share list status=%d body=%s", listed.Code, listed.Body.String())
	}

	metadata := publicFileRequest(t, mux, "/api/file-shares/"+share.Token)
	if metadata.Code != http.StatusOK || bytes.Contains(metadata.Body.Bytes(), shareData) {
		t.Fatalf("metadata status=%d body=%s", metadata.Code, metadata.Body.String())
	}
	download := publicFileRequest(t, mux, "/api/file-shares/"+share.Token+"/download")
	if download.Code != http.StatusOK {
		t.Fatalf("download status=%d body=%s", download.Code, download.Body.String())
	}
	var downloadPayload struct {
		EncryptedData string `json:"encrypted_data"`
	}
	if err := json.Unmarshal(download.Body.Bytes(), &downloadPayload); err != nil ||
		downloadPayload.EncryptedData != base64.StdEncoding.EncodeToString(shareData) {
		t.Fatalf("download payload=%+v err=%v", downloadPayload, err)
	}
	var count int
	if err := db.QueryRow(`SELECT download_count FROM file_shares WHERE id=?`, share.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("download count=%d err=%v", count, err)
	}

	denied := fileRequest(t, mux, http.MethodDelete, "/api/file-shares/"+formatID(share.ID), nil, sender)
	if denied.Code != http.StatusNotFound {
		t.Fatalf("non-creator revoke status=%d body=%s", denied.Code, denied.Body.String())
	}
	revoked := fileRequest(t, mux, http.MethodDelete, "/api/file-shares/"+formatID(share.ID), nil, recipient)
	if revoked.Code != http.StatusOK {
		t.Fatalf("creator revoke status=%d body=%s", revoked.Code, revoked.Body.String())
	}
	unavailable := publicFileRequest(t, mux, "/api/file-shares/"+share.Token)
	if unavailable.Code != http.StatusGone {
		t.Fatalf("revoked metadata status=%d body=%s", unavailable.Code, unavailable.Body.String())
	}
}

func TestFileShareRequiresConversationMembershipAndValidExpiration(t *testing.T) {
	db, conversationID, sender, _ := setupFileConversation(t)
	defer db.Close()

	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := fileMux(authHandlerForTest(db), handler)
	uploaded := fileRequest(t, mux, http.MethodPost, "/api/files", uploadBody(conversationID), sender)
	var uploadedFile struct {
		File struct {
			ID int64 `json:"id"`
		} `json:"file"`
	}
	_ = json.Unmarshal(uploaded.Body.Bytes(), &uploadedFile)
	body := map[string]any{
		"encrypted_name":     `{"iv":"share-name-iv","data":"share-name-data"}`,
		"encrypted_mime":     `{"iv":"share-mime-iv","data":"share-mime-data"}`,
		"encrypted_data":     base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 20)),
		"iv":                 "share-data-iv",
		"size":               4,
		"expires_in_seconds": 3600,
	}
	outsider := registerFileUser(t, authHandlerForTest(db), "share_outsider")
	denied := fileRequest(t, mux, http.MethodPost, "/api/files/"+formatID(uploadedFile.File.ID)+"/shares", body, outsider)
	if denied.Code != http.StatusNotFound {
		t.Fatalf("outsider create status=%d body=%s", denied.Code, denied.Body.String())
	}
	body["expires_in_seconds"] = 0
	invalid := fileRequest(t, mux, http.MethodPost, "/api/files/"+formatID(uploadedFile.File.ID)+"/shares", body, sender)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid expiry status=%d body=%s", invalid.Code, invalid.Body.String())
	}
}

func TestFileFolderListsAndCancelsCurrentUsersActiveShares(t *testing.T) {
	db, conversationID, sender, recipient := setupFileConversation(t)
	defer db.Close()

	handler := &Handler{DB: db, Hub: &testHub{}}
	mux := fileMux(authHandlerForTest(db), handler)
	uploaded := fileRequest(t, mux, http.MethodPost, "/api/files", uploadBody(conversationID), sender)
	var uploadedFile struct {
		File struct {
			ID int64 `json:"id"`
		} `json:"file"`
	}
	if uploaded.Code != http.StatusCreated || json.Unmarshal(uploaded.Body.Bytes(), &uploadedFile) != nil {
		t.Fatalf("upload status=%d body=%s", uploaded.Code, uploaded.Body.String())
	}
	shareBody := map[string]any{
		"encrypted_name":     `{"iv":"share-name-iv","data":"share-name-data"}`,
		"encrypted_mime":     `{"iv":"share-mime-iv","data":"share-mime-data"}`,
		"encrypted_data":     base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 20)),
		"iv":                 "share-data-iv",
		"size":               4,
		"expires_in_seconds": 3600,
	}
	created := fileRequest(t, mux, http.MethodPost, "/api/files/"+formatID(uploadedFile.File.ID)+"/shares", shareBody, recipient)
	if created.Code != http.StatusCreated {
		t.Fatalf("share create status=%d body=%s", created.Code, created.Body.String())
	}
	var share struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &share); err != nil {
		t.Fatal(err)
	}

	listed := fileRequest(t, mux, http.MethodGet, "/api/files", nil, recipient)
	var files []listedFileMessage
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &files) != nil || len(files) != 1 ||
		files[0].File == nil || files[0].File.ActiveShareCount != 1 {
		t.Fatalf("listed shared files status=%d files=%+v body=%s", listed.Code, files, listed.Body.String())
	}

	denied := fileRequest(t, mux, http.MethodDelete, "/api/files/"+formatID(uploadedFile.File.ID)+"/shares", nil, sender)
	if denied.Code != http.StatusNotFound {
		t.Fatalf("other member cancel status=%d body=%s", denied.Code, denied.Body.String())
	}
	cancelled := fileRequest(t, mux, http.MethodDelete, "/api/files/"+formatID(uploadedFile.File.ID)+"/shares", nil, recipient)
	if cancelled.Code != http.StatusOK || !bytes.Contains(cancelled.Body.Bytes(), []byte(`"revoked_count":1`)) {
		t.Fatalf("creator cancel status=%d body=%s", cancelled.Code, cancelled.Body.String())
	}
	unavailable := publicFileRequest(t, mux, "/api/file-shares/"+share.Token)
	if unavailable.Code != http.StatusGone {
		t.Fatalf("cancelled share status=%d body=%s", unavailable.Code, unavailable.Body.String())
	}

	listed = fileRequest(t, mux, http.MethodGet, "/api/files", nil, recipient)
	files = nil
	if listed.Code != http.StatusOK || json.Unmarshal(listed.Body.Bytes(), &files) != nil || len(files) != 1 ||
		files[0].File == nil || files[0].File.ActiveShareCount != 0 {
		t.Fatalf("listed cancelled files status=%d files=%+v body=%s", listed.Code, files, listed.Body.String())
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
	mux.Handle("GET /api/files", authHandler.Middleware(http.HandlerFunc(handler.List)))
	mux.Handle("GET /api/files/{id}", authHandler.Middleware(http.HandlerFunc(handler.Download)))
	mux.Handle("POST /api/files/{id}/shares", authHandler.Middleware(http.HandlerFunc(handler.CreateShare)))
	mux.Handle("GET /api/files/{id}/shares", authHandler.Middleware(http.HandlerFunc(handler.ListShares)))
	mux.Handle("DELETE /api/files/{id}/shares", authHandler.Middleware(http.HandlerFunc(handler.DeleteFileShares)))
	mux.HandleFunc("GET /api/file-shares/{token}", handler.PublicShare)
	mux.HandleFunc("GET /api/file-shares/{token}/download", handler.DownloadShare)
	mux.Handle("DELETE /api/file-shares/{id}", authHandler.Middleware(http.HandlerFunc(handler.DeleteShare)))
	return mux
}

func publicFileRequest(t *testing.T, mux http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	return response
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
