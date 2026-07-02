package settings

import (
	"database/sql"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const InvitationCodeKey = "invitation_code_hash"
const InvitationCodeRequiredKey = "invitation_code_required"

func HasInvitationCode(db *sql.DB) (bool, error) {
	var value string
	err := db.QueryRow("SELECT value FROM app_settings WHERE `key`=?", InvitationCodeKey).Scan(&value)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(value) != "", nil
}

func VerifyInvitationCode(db *sql.DB, code string) (bool, error) {
	var hash string
	err := db.QueryRow("SELECT value FROM app_settings WHERE `key`=?", InvitationCodeKey).Scan(&hash)
	if err == sql.ErrNoRows || strings.TrimSpace(hash) == "" {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(strings.TrimSpace(code))) == nil, nil
}

func InvitationCodeRequired(db *sql.DB) (bool, error) {
	var value string
	err := db.QueryRow("SELECT value FROM app_settings WHERE `key`=?", InvitationCodeRequiredKey).Scan(&value)
	if err == sql.ErrNoRows {
		return HasInvitationCode(db)
	}
	if err != nil {
		return false, err
	}
	return value == "1", nil
}

func SetInvitationCodeRequired(db *sql.DB, required bool) error {
	value := "0"
	if required {
		value = "1"
	}
	return setAppSetting(db, InvitationCodeRequiredKey, value)
}

func SetInvitationCode(db *sql.DB, code string) error {
	code = strings.TrimSpace(code)
	if code == "" {
		_, err := db.Exec("DELETE FROM app_settings WHERE `key`=?", InvitationCodeKey)
		return err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(code), 12)
	if err != nil {
		return err
	}
	return setAppSetting(db, InvitationCodeKey, string(hash))
}

func setAppSetting(db *sql.DB, key, value string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM app_settings WHERE `key`=?", key); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO app_settings(`key`,value,updated_at) VALUES(?,?,?)",
		key, value, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	return tx.Commit()
}
