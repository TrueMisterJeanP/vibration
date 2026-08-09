package users

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

func TestSearchByDirectoryRoleRespectsVisibilityAndAccountState(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	authHandler := &auth.Handler{DB: db}
	userHandler := &Handler{DB: db}
	seeker := registerUserNamed(t, authHandler, "role_seeker")
	_ = registerUserNamed(t, authHandler, "visible_admin")
	_ = registerUserNamed(t, authHandler, "hidden_admin")
	_ = registerUserNamed(t, authHandler, "visible_manager")
	_ = registerUserNamed(t, authHandler, "banned_manager")
	if _, err := db.Exec(`UPDATE users SET is_admin=1 WHERE id IN (2,3)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE users SET is_discoverable=0 WHERE id=3`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE users SET is_manager=1 WHERE id IN (4,5)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE users SET is_banned=1 WHERE id=5`); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("POST /api/users/search", authHandler.Middleware(http.HandlerFunc(userHandler.Search)))

	administrators := searchUsersByRole(t, mux, seeker, "Administrateur", "administrator")
	if len(administrators) != 2 || administrators[0].ID != 1 || administrators[0].Username != "role_seeker" ||
		administrators[1].ID != 2 || administrators[1].Username != "visible_admin" {
		t.Fatalf("unexpected administrator directory: %+v", administrators)
	}
	managers := searchUsersByRole(t, mux, seeker, "Gestionnaire", "manager")
	if len(managers) != 1 || managers[0].ID != 4 || managers[0].Username != "visible_manager" {
		t.Fatalf("unexpected manager directory: %+v", managers)
	}
	legacyClient := searchUsersByRole(t, mux, seeker, "Administrateur", "")
	if len(legacyClient) != 2 || legacyClient[0].ID != 1 || legacyClient[1].ID != 2 {
		t.Fatalf("query-only administrator directory: %+v", legacyClient)
	}
	invalid := discoveryRequest(t, mux, seeker, "/api/users/search", map[string]string{"query": "Propriétaire", "role": "owner"})
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid directory role status=%d body=%s", invalid.Code, invalid.Body.String())
	}
}

func searchUsersByRole(t *testing.T, mux http.Handler, cookie *http.Cookie, query, role string) []User {
	t.Helper()
	response := discoveryRequest(t, mux, cookie, "/api/users/search", map[string]string{"query": query, "role": role})
	if response.Code != http.StatusOK {
		t.Fatalf("role search status=%d body=%s", response.Code, response.Body.String())
	}
	var users []User
	if err := json.Unmarshal(response.Body.Bytes(), &users); err != nil {
		t.Fatal(err)
	}
	return users
}
