//go:build community

package db

import (
	"database/sql"
	"fmt"
	"net/url"
	"strings"

	_ "modernc.org/sqlite"
)

func Open(path string) (*sql.DB, error) {
	database, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	if err := database.Ping(); err != nil {
		database.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if err := Migrate(database); err != nil {
		database.Close()
		return nil, err
	}
	return database, nil
}

func OpenReadOnly(path string) (*sql.DB, error) {
	uri := url.URL{Scheme: "file", Path: path}
	query := uri.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "foreign_keys(1)")
	query.Add("_pragma", "busy_timeout(5000)")
	uri.RawQuery = query.Encode()
	database, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, err
	}
	database.SetMaxOpenConns(1)
	if err := database.Ping(); err != nil {
		database.Close()
		return nil, fmt.Errorf("ping sqlite read-only: %w", err)
	}
	return database, nil
}

func OpenConfigured(driver, sqlitePath, dsn string) (*sql.DB, error) {
	return OpenConfiguredPool(driver, sqlitePath, dsn, DefaultPool())
}

// OpenConfiguredPool keeps the enterprise signature so shared code compiles
// unchanged. The community edition supports SQLite only, which always runs on a
// single connection, so the pool settings are not applicable.
func OpenConfiguredPool(driver, sqlitePath, _ string, _ Pool) (*sql.DB, error) {
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "", "sqlite", "sqlite3":
		return Open(sqlitePath)
	default:
		return nil, fmt.Errorf("community edition supports sqlite only")
	}
}
