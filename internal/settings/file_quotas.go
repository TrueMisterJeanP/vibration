package settings

import (
	"database/sql"
	"fmt"
	"strconv"
	"time"
)

const (
	FileQuotaMaxFileSizeKey = "file_quota_max_file_size"
	FileQuotaMaxUserSizeKey = "file_quota_max_user_size"
	DefaultMaxFileSize      = 25 << 20
	DefaultMaxUserStorage   = 1 << 30
	MaxConfiguredQuotaBytes = 1 << 40
)

type FileQuotas struct {
	MaxFileSize    int64 `json:"max_file_size"`
	MaxUserStorage int64 `json:"max_user_storage"`
}

type settingsQueryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

func DefaultFileQuotas() FileQuotas {
	return FileQuotas{
		MaxFileSize:    DefaultMaxFileSize,
		MaxUserStorage: DefaultMaxUserStorage,
	}
}

func LoadFileQuotas(db settingsQueryer) (FileQuotas, error) {
	quotas := DefaultFileQuotas()
	for _, item := range []struct {
		key   string
		value *int64
	}{
		{FileQuotaMaxFileSizeKey, &quotas.MaxFileSize},
		{FileQuotaMaxUserSizeKey, &quotas.MaxUserStorage},
	} {
		var raw string
		err := db.QueryRow("SELECT value FROM app_settings WHERE `key`=?", item.key).Scan(&raw)
		if err == sql.ErrNoRows {
			continue
		}
		if err != nil {
			return FileQuotas{}, err
		}
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			return FileQuotas{}, fmt.Errorf("invalid file quota setting %s", item.key)
		}
		*item.value = parsed
	}
	if err := ValidateFileQuotas(quotas); err != nil {
		return FileQuotas{}, err
	}
	return quotas, nil
}

func ValidateFileQuotas(quotas FileQuotas) error {
	if quotas.MaxFileSize <= 0 || quotas.MaxUserStorage <= 0 ||
		quotas.MaxFileSize > MaxConfiguredQuotaBytes || quotas.MaxUserStorage > MaxConfiguredQuotaBytes ||
		quotas.MaxFileSize > quotas.MaxUserStorage {
		return fmt.Errorf("invalid file quotas")
	}
	return nil
}

func SaveFileQuotas(db *sql.DB, quotas FileQuotas) error {
	if err := ValidateFileQuotas(quotas); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for key, value := range map[string]int64{
		FileQuotaMaxFileSizeKey: quotas.MaxFileSize,
		FileQuotaMaxUserSizeKey: quotas.MaxUserStorage,
	} {
		if _, err := tx.Exec("DELETE FROM app_settings WHERE `key`=?", key); err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT INTO app_settings(`key`,value,updated_at) VALUES(?,?,?)",
			key, strconv.FormatInt(value, 10), now); err != nil {
			return err
		}
	}
	return tx.Commit()
}
