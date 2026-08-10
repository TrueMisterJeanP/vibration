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
	Query(query string, args ...any) (*sql.Rows, error)
}

func DefaultFileQuotas() FileQuotas {
	return FileQuotas{
		MaxFileSize:    DefaultMaxFileSize,
		MaxUserStorage: DefaultMaxUserStorage,
	}
}

func LoadFileQuotas(db settingsQueryer) (FileQuotas, error) {
	quotas := DefaultFileQuotas()
	rows, err := db.Query("SELECT `key`,value FROM app_settings WHERE `key` IN (?,?)",
		FileQuotaMaxFileSizeKey, FileQuotaMaxUserSizeKey)
	if err != nil {
		return FileQuotas{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			return FileQuotas{}, err
		}
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			return FileQuotas{}, fmt.Errorf("invalid file quota setting %s", key)
		}
		switch key {
		case FileQuotaMaxFileSizeKey:
			quotas.MaxFileSize = parsed
		case FileQuotaMaxUserSizeKey:
			quotas.MaxUserStorage = parsed
		}
	}
	if err := rows.Err(); err != nil {
		return FileQuotas{}, err
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
