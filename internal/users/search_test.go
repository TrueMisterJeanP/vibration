package users

import (
	"net/http"
	"path/filepath"
	"testing"

	"chat-pwa-go/internal/auth"
	database "chat-pwa-go/internal/db"
)

func TestSearchByUsernameAndDisplayNameRespectsVisibility(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	authHandler := &auth.Handler{DB: db}
	userHandler := &Handler{DB: db}
	seeker := registerUserNamed(t, authHandler, "search_seeker")
	_ = registerUserNamed(t, authHandler, "visible_username")
	_ = registerUserNamed(t, authHandler, "visible_display")
	_ = registerUserNamed(t, authHandler, "hidden_display")

	longDisplayName := "Équipe Produit avec un nom affiché particulièrement long"
	if _, err := db.Exec(`UPDATE users SET display_name=? WHERE id=3`, longDisplayName); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE users SET display_name='Équipe Produit privée',is_discoverable=0 WHERE id=4`); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("POST /api/users/search", authHandler.Middleware(http.HandlerFunc(userHandler.Search)))

	byUsername := searchUsers(t, mux, seeker, "visible_user")
	if len(byUsername) != 1 || byUsername[0].ID != 2 {
		t.Fatalf("username search returned unexpected users: %+v", byUsername)
	}
	byDisplayName := searchUsers(t, mux, seeker, "produit avec")
	if len(byDisplayName) != 1 || byDisplayName[0].ID != 3 {
		t.Fatalf("display-name search returned unexpected users: %+v", byDisplayName)
	}
	byLongDisplayName := searchUsers(t, mux, seeker, longDisplayName)
	if len(byLongDisplayName) != 1 || byLongDisplayName[0].ID != 3 {
		t.Fatalf("long display-name search returned unexpected users: %+v", byLongDisplayName)
	}
	if hidden := searchUsers(t, mux, seeker, "produit privée"); len(hidden) != 0 {
		t.Fatalf("hidden user leaked through display-name search: %+v", hidden)
	}

	if _, err := db.Exec(`INSERT INTO contacts(owner_id,contact_user_id,status,created_at) VALUES(1,4,'accepted','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	knownHidden := searchUsers(t, mux, seeker, "produit privée")
	if len(knownHidden) != 1 || knownHidden[0].ID != 4 {
		t.Fatalf("known hidden contact missing from display-name search: %+v", knownHidden)
	}
}
