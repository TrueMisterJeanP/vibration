package db

import (
	"path/filepath"
	"testing"
)

func TestActiveConfigFallbackAndSave(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database_config.json")
	value, found, err := LoadActiveConfig(path, "sqlite", "")
	if err != nil {
		t.Fatal(err)
	}
	if found || value.Driver != "sqlite" || value.DSN != "" {
		t.Fatalf("fallback value=%#v found=%v", value, found)
	}

	saved, err := SaveActiveConfig(path, ActiveConfig{Driver: "mariadb", DSN: "user:pass@tcp(localhost:3306)/db"})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Driver != "mysql" {
		t.Fatalf("saved driver=%q", saved.Driver)
	}

	loaded, found, err := LoadActiveConfig(path, "sqlite", "")
	if err != nil {
		t.Fatal(err)
	}
	if !found || loaded.Driver != "mysql" || loaded.DSN == "" {
		t.Fatalf("loaded value=%#v found=%v", loaded, found)
	}
}

func TestSaveActiveConfigClearsSQLiteDSN(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database_config.json")
	saved, err := SaveActiveConfig(path, ActiveConfig{Driver: "sqlite", DSN: "ignored"})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Driver != "sqlite" || saved.DSN != "" {
		t.Fatalf("saved sqlite value=%#v", saved)
	}
}
