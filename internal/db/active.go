package db

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type ActiveConfig struct {
	Driver    string `json:"driver"`
	DSN       string `json:"dsn,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`
}

func LoadActiveConfig(path, fallbackDriver, fallbackDSN string) (ActiveConfig, bool, error) {
	fallback := ActiveConfig{Driver: normalizeActiveDriver(fallbackDriver), DSN: strings.TrimSpace(fallbackDSN)}
	if fallback.Driver == "" {
		fallback.Driver = "sqlite"
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return fallback, false, nil
	}
	if err != nil {
		return ActiveConfig{}, false, err
	}
	var value ActiveConfig
	if err := json.Unmarshal(data, &value); err != nil {
		return ActiveConfig{}, false, err
	}
	value.Driver = normalizeActiveDriver(value.Driver)
	value.DSN = strings.TrimSpace(value.DSN)
	if value.Driver == "" {
		value.Driver = "sqlite"
	}
	return value, true, nil
}

func SaveActiveConfig(path string, value ActiveConfig) (ActiveConfig, error) {
	value.Driver = normalizeActiveDriver(value.Driver)
	value.DSN = strings.TrimSpace(value.DSN)
	if value.Driver == "" {
		value.Driver = "sqlite"
	}
	if value.Driver == "sqlite" {
		value.DSN = ""
	}
	value.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return ActiveConfig{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return ActiveConfig{}, err
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o600); err != nil {
		return ActiveConfig{}, err
	}
	return value, nil
}

func normalizeActiveDriver(driver string) string {
	switch strings.ToLower(strings.TrimSpace(driver)) {
	case "", "sqlite", "sqlite3":
		return "sqlite"
	case "mariadb", "mysql":
		return "mysql"
	case "postgres", "postgresql", "pgx":
		return "postgres"
	default:
		return strings.ToLower(strings.TrimSpace(driver))
	}
}

func IsSQLiteDriver(driver string) bool {
	return normalizeActiveDriver(driver) == "sqlite"
}
