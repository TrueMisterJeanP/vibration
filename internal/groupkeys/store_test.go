package groupkeys

import (
	"errors"
	"path/filepath"
	"testing"

	database "chat-pwa-go/internal/db"
)

func TestValidateSendRejectsStaleEpochAndFrozenGroup(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
		VALUES(1,'owner','Owner','hash','public-key','private-key','salt','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO conversations(id,type,encrypted_title,created_by,current_key_epoch,created_at)
		VALUES(1,'group','encrypted-title',1,2,'2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO conversation_members(conversation_id,user_id,encrypted_conversation_key,role,created_at)
		VALUES(1,1,'encrypted-key','owner','2026-01-01T00:00:00Z')`); err != nil {
		t.Fatal(err)
	}

	tx, _ := db.Begin()
	if _, err := ValidateSend(tx, 1, 1, 1); !errors.Is(err, ErrStaleEpoch) {
		t.Fatalf("stale epoch error=%v", err)
	}
	_ = tx.Rollback()

	tx, _ = db.Begin()
	if epoch, err := ValidateSend(tx, 1, 1, 2); err != nil || epoch != 2 {
		t.Fatalf("current epoch=%d error=%v", epoch, err)
	}
	_ = tx.Rollback()

	if _, err := db.Exec(`UPDATE conversations SET rotation_required=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	tx, _ = db.Begin()
	if _, err := ValidateSend(tx, 1, 1, 2); !errors.Is(err, ErrRotationRequired) {
		t.Fatalf("frozen group error=%v", err)
	}
	_ = tx.Rollback()
}
