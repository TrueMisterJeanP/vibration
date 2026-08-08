package contacts

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

func TestContactRequestMustBeAccepted(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db}
	first := registerContactUser(t, authHandler, "contact_requester")
	second := registerContactUser(t, authHandler, "contact_receiver")
	mux := http.NewServeMux()
	mux.Handle("GET /api/contacts", authHandler.Middleware(http.HandlerFunc(handler.List)))
	mux.Handle("POST /api/contacts", authHandler.Middleware(http.HandlerFunc(handler.Create)))
	mux.Handle("POST /api/contacts/{id}/accept", authHandler.Middleware(http.HandlerFunc(handler.Accept)))
	mux.Handle("DELETE /api/contacts/{id}", authHandler.Middleware(http.HandlerFunc(handler.Delete)))
	mux.Handle("GET /api/carnet", authHandler.Middleware(http.HandlerFunc(handler.CarnetList)))
	mux.Handle("DELETE /api/carnet", authHandler.Middleware(http.HandlerFunc(handler.CarnetDeleteAll)))
	mux.Handle("DELETE /api/carnet/{id}", authHandler.Middleware(http.HandlerFunc(handler.CarnetDelete)))

	created := contactRequest(t, mux, http.MethodPost, "/api/contacts", map[string]int64{"user_id": 2}, first)
	if created.Code != http.StatusCreated {
		t.Fatalf("create contact status=%d body=%s", created.Code, created.Body.String())
	}

	incoming := contactRequest(t, mux, http.MethodGet, "/api/contacts", nil, second)
	if incoming.Code != http.StatusOK {
		t.Fatalf("list contacts status=%d body=%s", incoming.Code, incoming.Body.String())
	}
	var contacts []Contact
	if err := json.Unmarshal(incoming.Body.Bytes(), &contacts); err != nil {
		t.Fatal(err)
	}
	if len(contacts) != 1 || contacts[0].Status != "pending" || contacts[0].Direction != "incoming" {
		t.Fatalf("incoming contacts=%+v", contacts)
	}

	accepted := contactRequest(t, mux, http.MethodPost, "/api/contacts/1/accept", nil, second)
	if accepted.Code != http.StatusOK {
		t.Fatalf("accept contact status=%d body=%s", accepted.Code, accepted.Body.String())
	}
	var acceptedBody struct {
		ConversationID int64 `json:"conversation_id"`
	}
	if err := json.Unmarshal(accepted.Body.Bytes(), &acceptedBody); err != nil {
		t.Fatal(err)
	}
	if acceptedBody.ConversationID <= 0 {
		t.Fatalf("accept did not create conversation: %s", accepted.Body.String())
	}
	var reciprocal int
	if err := db.QueryRow(`SELECT COUNT(*) FROM contacts WHERE owner_id=2 AND contact_user_id=1 AND status='accepted'`).Scan(&reciprocal); err != nil || reciprocal != 1 {
		t.Fatalf("reciprocal accepted contact=%d err=%v", reciprocal, err)
	}
	var memberCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=?`, acceptedBody.ConversationID).Scan(&memberCount); err != nil || memberCount != 2 {
		t.Fatalf("conversation members=%d err=%v", memberCount, err)
	}
	for _, userID := range []int64{1, 2} {
		var count int
		if err := db.QueryRow(`SELECT COUNT(*) FROM conversation_members WHERE conversation_id=? AND user_id=?`, acceptedBody.ConversationID, userID).Scan(&count); err != nil || count != 1 {
			t.Fatalf("conversation member user=%d count=%d err=%v", userID, count, err)
		}
	}
	carnetList := contactRequest(t, mux, http.MethodGet, "/api/carnet", nil, first)
	if carnetList.Code != http.StatusOK {
		t.Fatalf("carnet list status=%d body=%s", carnetList.Code, carnetList.Body.String())
	}
	var carnet []CarnetEntry
	if err := json.Unmarshal(carnetList.Body.Bytes(), &carnet); err != nil {
		t.Fatal(err)
	}
	if len(carnet) != 1 || !carnet[0].HasPrivateConversation {
		t.Fatalf("private conversation should be exposed in carnet: %+v", carnet)
	}

	deleted := contactRequest(t, mux, http.MethodDelete, "/api/contacts/2", nil, second)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete accepted contact status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	var remainingContacts int
	if err := db.QueryRow(`SELECT COUNT(*) FROM contacts WHERE (owner_id=1 AND contact_user_id=2) OR (owner_id=2 AND contact_user_id=1)`).Scan(&remainingContacts); err != nil || remainingContacts != 0 {
		t.Fatalf("remaining accepted contacts=%d err=%v", remainingContacts, err)
	}
	var remainingConversations int
	if err := db.QueryRow(`SELECT COUNT(*) FROM conversations WHERE id=?`, acceptedBody.ConversationID).Scan(&remainingConversations); err != nil || remainingConversations != 0 {
		t.Fatalf("remaining private conversation=%d err=%v", remainingConversations, err)
	}
	var carnetEntries int
	if err := db.QueryRow(`SELECT COUNT(*) FROM carnet_entries WHERE owner_id=1 AND contact_user_id=2`).Scan(&carnetEntries); err != nil || carnetEntries != 1 {
		t.Fatalf("preserved carnet entry=%d err=%v", carnetEntries, err)
	}
}

func TestCarnetProtectsCurrentGroupMembersAndDeletesOldEntries(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db}
	first := registerContactUser(t, authHandler, "carnet_owner")
	registerContactUser(t, authHandler, "carnet_member_one")
	registerContactUser(t, authHandler, "carnet_member_two")

	result, err := db.Exec(`INSERT INTO conversations(type,created_by,created_at) VALUES('group',1,?)`, "2026-01-01T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	conversationID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	for _, userID := range []int64{1, 2, 3} {
		if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at) VALUES(?,?,?,?,?)`,
			conversationID, userID, "encrypted-key", "member", "2026-01-01T00:00:00Z"); err != nil {
			t.Fatal(err)
		}
	}

	mux := http.NewServeMux()
	mux.Handle("GET /api/carnet", authHandler.Middleware(http.HandlerFunc(handler.CarnetList)))
	mux.Handle("DELETE /api/carnet", authHandler.Middleware(http.HandlerFunc(handler.CarnetDeleteAll)))
	mux.Handle("DELETE /api/carnet/{id}", authHandler.Middleware(http.HandlerFunc(handler.CarnetDelete)))
	list := contactRequest(t, mux, http.MethodGet, "/api/carnet", nil, first)
	if list.Code != http.StatusOK {
		t.Fatalf("carnet list status=%d body=%s", list.Code, list.Body.String())
	}
	var entries []CarnetEntry
	if err := json.Unmarshal(list.Body.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || !entries[0].Active || !entries[1].Active || entries[0].HasPrivateConversation || entries[1].HasPrivateConversation {
		t.Fatalf("current group entries=%+v", entries)
	}
	blocked := contactRequest(t, mux, http.MethodDelete, "/api/carnet/1", nil, first)
	if blocked.Code != http.StatusConflict {
		t.Fatalf("active carnet deletion status=%d body=%s", blocked.Code, blocked.Body.String())
	}
	blockedAll := contactRequest(t, mux, http.MethodDelete, "/api/carnet", nil, first)
	if blockedAll.Code != http.StatusOK || !strings.Contains(blockedAll.Body.String(), `"deleted":0`) {
		t.Fatalf("active carnet bulk deletion status=%d body=%s", blockedAll.Code, blockedAll.Body.String())
	}

	if _, err := db.Exec(`DELETE FROM conversations WHERE id=?`, conversationID); err != nil {
		t.Fatal(err)
	}
	old := contactRequest(t, mux, http.MethodGet, "/api/carnet", nil, first)
	if old.Code != http.StatusOK {
		t.Fatalf("old carnet list status=%d body=%s", old.Code, old.Body.String())
	}
	entries = nil
	if err := json.Unmarshal(old.Body.Bytes(), &entries); err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Active || entries[1].Active {
		t.Fatalf("old group entries=%+v", entries)
	}
	deleted := contactRequest(t, mux, http.MethodDelete, "/api/carnet", nil, first)
	if deleted.Code != http.StatusOK || !strings.Contains(deleted.Body.String(), `"deleted":2`) {
		t.Fatalf("old carnet bulk deletion status=%d body=%s", deleted.Code, deleted.Body.String())
	}
}

func TestRequesterCanDeleteAcceptedContact(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	handler := &Handler{DB: db}
	first := registerContactUser(t, authHandler, "contact_requester_delete")
	second := registerContactUser(t, authHandler, "contact_receiver_delete")
	mux := http.NewServeMux()
	mux.Handle("GET /api/contacts", authHandler.Middleware(http.HandlerFunc(handler.List)))
	mux.Handle("POST /api/contacts", authHandler.Middleware(http.HandlerFunc(handler.Create)))
	mux.Handle("POST /api/contacts/{id}/accept", authHandler.Middleware(http.HandlerFunc(handler.Accept)))
	mux.Handle("DELETE /api/contacts/{id}", authHandler.Middleware(http.HandlerFunc(handler.Delete)))

	created := contactRequest(t, mux, http.MethodPost, "/api/contacts", map[string]int64{"user_id": 2}, first)
	if created.Code != http.StatusCreated {
		t.Fatalf("create contact status=%d body=%s", created.Code, created.Body.String())
	}
	accepted := contactRequest(t, mux, http.MethodPost, "/api/contacts/1/accept", nil, second)
	if accepted.Code != http.StatusOK {
		t.Fatalf("accept contact status=%d body=%s", accepted.Code, accepted.Body.String())
	}

	list := contactRequest(t, mux, http.MethodGet, "/api/contacts", nil, first)
	if list.Code != http.StatusOK {
		t.Fatalf("requester list status=%d body=%s", list.Code, list.Body.String())
	}
	var contacts []Contact
	if err := json.Unmarshal(list.Body.Bytes(), &contacts); err != nil {
		t.Fatal(err)
	}
	if len(contacts) != 1 || contacts[0].ID != 1 || contacts[0].Status != "accepted" || contacts[0].Direction != "outgoing" {
		t.Fatalf("requester accepted contacts=%+v", contacts)
	}

	deleted := contactRequest(t, mux, http.MethodDelete, "/api/contacts/1", nil, first)
	if deleted.Code != http.StatusOK {
		t.Fatalf("requester delete accepted contact status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	var remainingContacts int
	if err := db.QueryRow(`SELECT COUNT(*) FROM contacts WHERE (owner_id=1 AND contact_user_id=2) OR (owner_id=2 AND contact_user_id=1)`).Scan(&remainingContacts); err != nil || remainingContacts != 0 {
		t.Fatalf("remaining accepted contacts=%d err=%v", remainingContacts, err)
	}
}

func registerContactUser(t *testing.T, handler *auth.Handler, username string) *http.Cookie {
	t.Helper()
	payload := map[string]string{
		"username": username, "display_name": username, "password": "Password123!",
		"public_key":            `{"kty":"EC","x":"public-key-placeholder"}`,
		"encrypted_private_key": `{"v":2,"kdf":{"name":"argon2id","version":19,"memory_kib":32768,"iterations":3,"parallelism":1,"hash_length":32,"salt":"AAAAAAAAAAAAAAAAAAAAAA=="},"cipher":{"name":"AES-GCM","iv":"AAAAAAAAAAAAAAAA"},"data":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`,
		"crypto_salt":           "argon2id-v2",
		"signing_public_key":    `{"kty":"EC","crv":"P-256","x":"P1xgrChMoYjH2ksx1_ths9hjWlAUzXvm1iGGKf9wi34","y":"tijzBhBWCeQyQZADxQdzy0iJzba2WLy16qh0vHHsFRw"}`,
		"signing_key_id":        "123a50372c29870ea73e4f730448f1d936620091eae3642c6f54b5b0377bbaa6",
	}
	data, _ := json.Marshal(payload)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/register", bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	handler.Register(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("register status=%d body=%s", response.Code, response.Body.String())
	}
	return response.Result().Cookies()[0]
}

func contactRequest(t *testing.T, mux http.Handler, method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		data, _ = json.Marshal(body)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(cookie)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, req)
	return response
}
