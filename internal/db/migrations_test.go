package db

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestOpenCreatesRequiredTables(t *testing.T) {
	database, err := Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	required := []string{
		"users", "sessions", "contacts", "conversations", "conversation_members",
		"messages", "message_events", "message_reactions", "message_pins", "poll_options", "poll_votes", "message_receipts", "files", "push_subscriptions", "admin_actions", "app_settings", "user_terms_acceptances",
		"federated_instances", "federated_conversations", "federated_message_map", "federation_outbox",
	}
	for _, table := range required {
		var count int
		if err := database.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Errorf("table %s was not created", table)
		}
	}
}

func TestOpenReadOnlyReadsExistingSQLite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	database, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?)`, "readonly_test", "ok", "2026-01-01T00:00:00Z"); err != nil {
		t.Fatal(err)
	}
	database.Close()

	readonly, err := OpenReadOnly(path)
	if err != nil {
		t.Fatal(err)
	}
	defer readonly.Close()
	var value string
	if err := readonly.QueryRow(`SELECT value FROM app_settings WHERE key=?`, "readonly_test").Scan(&value); err != nil {
		t.Fatal(err)
	}
	if value != "ok" {
		t.Fatalf("value=%q", value)
	}
}

func TestMigratePromotesFirstExistingUser(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`CREATE TABLE users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		display_name TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		public_key TEXT NOT NULL,
		encrypted_private_key TEXT NOT NULL,
		crypto_salt TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	INSERT INTO users(username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
	VALUES('first','First','hash','public','private','salt','2025-01-01T00:00:00Z'),
	      ('second','Second','hash','public','private','salt','2025-01-02T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	legacy.Close()

	database, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	var firstAdmin, secondAdmin bool
	if err := database.QueryRow(`SELECT is_admin FROM users WHERE username='first'`).Scan(&firstAdmin); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRow(`SELECT is_admin FROM users WHERE username='second'`).Scan(&secondAdmin); err != nil {
		t.Fatal(err)
	}
	if !firstAdmin || secondAdmin {
		t.Fatalf("unexpected roles: first=%v second=%v", firstAdmin, secondAdmin)
	}
	var avatarColumn int
	if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('users') WHERE name='avatar'`).Scan(&avatarColumn); err != nil {
		t.Fatal(err)
	}
	if avatarColumn != 1 {
		t.Fatal("users.avatar was not added")
	}
	var managerColumn int
	if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('users') WHERE name='is_manager'`).Scan(&managerColumn); err != nil {
		t.Fatal(err)
	}
	if managerColumn != 1 {
		t.Fatal("users.is_manager was not added")
	}
	var descriptionColumn int
	if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('users') WHERE name='description'`).Scan(&descriptionColumn); err != nil {
		t.Fatal(err)
	}
	if descriptionColumn != 1 {
		t.Fatal("users.description was not added")
	}
	var groupDescriptionColumn int
	if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name='encrypted_description'`).Scan(&groupDescriptionColumn); err != nil {
		t.Fatal(err)
	}
	if groupDescriptionColumn != 1 {
		t.Fatal("conversations.encrypted_description was not added")
	}
	var groupAvatarColumn int
	if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name='encrypted_avatar'`).Scan(&groupAvatarColumn); err != nil {
		t.Fatal(err)
	}
	if groupAvatarColumn != 1 {
		t.Fatal("conversations.encrypted_avatar was not added")
	}
	var federationKeyColumn int
	if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('conversations') WHERE name='federation_key_id'`).Scan(&federationKeyColumn); err != nil {
		t.Fatal(err)
	}
	if federationKeyColumn != 1 {
		t.Fatal("conversations.federation_key_id was not added")
	}
	for _, column := range []string{"is_remote", "remote_instance_id", "remote_username"} {
		var count int
		if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('users') WHERE name=?`, column).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("users.%s was not added", column)
		}
	}
}

func TestMigrateAddsMessageFeatureColumnsToLegacyMessages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-messages.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`CREATE TABLE users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		display_name TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		public_key TEXT NOT NULL,
		encrypted_private_key TEXT NOT NULL,
		crypto_salt TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE TABLE messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		conversation_id INTEGER NOT NULL,
		sender_id INTEGER NOT NULL,
		encrypted_content TEXT,
		iv TEXT NOT NULL,
		reply_to INTEGER,
		created_at TEXT NOT NULL,
		updated_at TEXT
	);
	INSERT INTO users(username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
	VALUES('first','First','hash','public','private','salt','2025-01-01T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	legacy.Close()

	database, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	for _, column := range []string{"expires_at", "poll_expires_at", "pinned_by", "pinned_at"} {
		var count int
		if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name=?`, column).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("messages.%s was not added", column)
		}
	}

	var indexCount int
	if err := database.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_messages_expires'`).Scan(&indexCount); err != nil {
		t.Fatal(err)
	}
	if indexCount != 1 {
		t.Fatal("idx_messages_expires was not created")
	}
}

func TestMigratePreservesLegacyPinForItsOwner(t *testing.T) {
	database, err := Open(filepath.Join(t.TempDir(), "legacy-pin.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	now := "2026-07-18T12:00:00Z"
	if _, err := database.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
		VALUES(1,'pin_owner','Pin Owner','hash','public','private','salt',?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO conversations(id,type,created_by,created_at) VALUES(1,'private',1,?)`, now); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`INSERT INTO messages(id,conversation_id,sender_id,encrypted_content,iv,pinned_by,pinned_at,created_at)
		VALUES(1,1,1,'encrypted','iv',1,?,?)`, now, now); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(database); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := database.QueryRow(`SELECT COUNT(*) FROM message_pins WHERE message_id=1 AND user_id=1 AND created_at=?`, now).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("migrated personal pin count=%d, want 1", count)
	}
}

func TestMigrateAddsFederationHostAndOutboxLockColumns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy-federation.db")
	legacy, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = legacy.Exec(`CREATE TABLE federated_instances (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		base_url TEXT UNIQUE NOT NULL,
		shared_secret TEXT NOT NULL,
		is_active INTEGER NOT NULL DEFAULT 1,
		last_seen_at TEXT,
		last_error TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE federation_outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		instance_id INTEGER NOT NULL,
		kind TEXT NOT NULL,
		payload TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at TEXT NOT NULL,
		last_error TEXT,
		created_at TEXT NOT NULL,
		sent_at TEXT
	);
	INSERT INTO federated_instances(name,base_url,shared_secret,is_active,created_at,updated_at)
	VALUES('Remote','https://remote.example:8443/base','secret',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	legacy.Close()

	database, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	var host string
	if err := database.QueryRow(`SELECT host FROM federated_instances WHERE base_url=?`, "https://remote.example:8443/base").Scan(&host); err != nil {
		t.Fatal(err)
	}
	if host != "remote.example:8443" {
		t.Fatalf("host=%q", host)
	}
	for _, column := range []string{"locked_by", "locked_until_at"} {
		var count int
		if err := database.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('federation_outbox') WHERE name=?`, column).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("federation_outbox.%s was not added", column)
		}
	}
	var indexCount int
	if err := database.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_federated_instances_host'`).Scan(&indexCount); err != nil {
		t.Fatal(err)
	}
	if indexCount != 1 {
		t.Fatal("idx_federated_instances_host was not created")
	}
}
