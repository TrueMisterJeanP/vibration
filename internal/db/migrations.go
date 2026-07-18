package db

import (
	"database/sql"
	"fmt"
	"net/url"
	"strings"
)

var migrations = []string{
	`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		display_name TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		password_hash TEXT NOT NULL,
		recovery_code_hash TEXT,
		public_key TEXT NOT NULL,
		encrypted_private_key TEXT NOT NULL,
		crypto_salt TEXT NOT NULL,
		avatar TEXT,
		is_remote INTEGER NOT NULL DEFAULT 0,
		remote_instance_id INTEGER REFERENCES federated_instances(id),
		remote_username TEXT,
			is_admin INTEGER NOT NULL DEFAULT 0,
			is_manager INTEGER NOT NULL DEFAULT 0,
			is_banned INTEGER NOT NULL DEFAULT 0,
		banned_reason TEXT,
		banned_at TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS user_terms_acceptances (
		user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		version INTEGER NOT NULL,
		accepted_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS contacts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		contact_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		encrypted_label TEXT,
		status TEXT NOT NULL DEFAULT 'accepted',
		created_at TEXT NOT NULL,
		UNIQUE(owner_id, contact_user_id)
	)`,
	`CREATE TABLE IF NOT EXISTS conversations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		type TEXT NOT NULL CHECK(type IN ('private','group')),
		encrypted_title TEXT,
		encrypted_description TEXT,
		encrypted_avatar TEXT,
		federation_key_id TEXT,
		created_by INTEGER NOT NULL REFERENCES users(id),
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS conversation_members (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		encrypted_conversation_key TEXT NOT NULL,
		role TEXT NOT NULL DEFAULT 'member',
		created_at TEXT NOT NULL,
		UNIQUE(conversation_id, user_id)
	)`,
	`CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
		sender_id INTEGER NOT NULL REFERENCES users(id),
		encrypted_content TEXT,
		iv TEXT NOT NULL,
		reply_to INTEGER REFERENCES messages(id) ON DELETE SET NULL,
		expires_at TEXT,
		poll_expires_at TEXT,
		pinned_by INTEGER REFERENCES users(id),
		pinned_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS message_reactions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		emoji TEXT NOT NULL,
		created_at TEXT NOT NULL,
		UNIQUE(message_id, user_id, emoji)
	)`,
	`CREATE TABLE IF NOT EXISTS message_pins (
		message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL,
		PRIMARY KEY(message_id, user_id)
	)`,
	`CREATE TABLE IF NOT EXISTS message_events (
		message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
		starts_at TEXT NOT NULL,
		ends_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS poll_options (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		position INTEGER NOT NULL,
		UNIQUE(message_id, position)
	)`,
	`CREATE TABLE IF NOT EXISTS poll_votes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL,
		UNIQUE(message_id, user_id)
	)`,
	`CREATE TABLE IF NOT EXISTS message_receipts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		status TEXT NOT NULL CHECK(status IN ('sent','delivered','read')),
		created_at TEXT NOT NULL,
		UNIQUE(message_id, user_id)
	)`,
	`CREATE TABLE IF NOT EXISTS files (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
		owner_id INTEGER NOT NULL REFERENCES users(id),
		encrypted_name TEXT NOT NULL,
		encrypted_mime TEXT NOT NULL,
		encrypted_data BLOB NOT NULL,
		iv TEXT NOT NULL,
		size INTEGER NOT NULL,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS file_shares (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
		created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		token_hash TEXT UNIQUE NOT NULL,
		encrypted_name TEXT NOT NULL,
		encrypted_mime TEXT NOT NULL,
		encrypted_data BLOB NOT NULL,
		iv TEXT NOT NULL,
		size INTEGER NOT NULL,
		expires_at TEXT NOT NULL,
		revoked_at TEXT,
		download_count INTEGER NOT NULL DEFAULT 0,
		last_downloaded_at TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS push_subscriptions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		endpoint TEXT NOT NULL,
		p256dh TEXT NOT NULL,
		auth TEXT NOT NULL,
		user_agent TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		UNIQUE(user_id, endpoint)
	)`,
	`CREATE TABLE IF NOT EXISTS admin_actions (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		admin_id INTEGER NOT NULL REFERENCES users(id),
		target_user_id INTEGER REFERENCES users(id),
		target_message_id INTEGER,
		action TEXT NOT NULL,
		details TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS federated_instances (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		base_url TEXT UNIQUE NOT NULL,
		host TEXT NOT NULL DEFAULT '',
		shared_secret TEXT NOT NULL,
		is_active INTEGER NOT NULL DEFAULT 1,
		last_seen_at TEXT,
		last_error TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS federated_conversations (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		local_conversation_id INTEGER UNIQUE NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
		instance_id INTEGER NOT NULL REFERENCES federated_instances(id) ON DELETE CASCADE,
		remote_conversation_id INTEGER NOT NULL,
		local_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		remote_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		federation_key_id TEXT NOT NULL,
		created_at TEXT NOT NULL,
		UNIQUE(instance_id, remote_conversation_id)
	)`,
	`CREATE TABLE IF NOT EXISTS federated_message_map (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		instance_id INTEGER NOT NULL REFERENCES federated_instances(id) ON DELETE CASCADE,
		remote_message_id INTEGER NOT NULL,
		local_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL,
		UNIQUE(instance_id, remote_message_id)
	)`,
	`CREATE TABLE IF NOT EXISTS federation_outbox (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		instance_id INTEGER NOT NULL REFERENCES federated_instances(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		payload TEXT NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		next_attempt_at TEXT NOT NULL,
		last_error TEXT,
		created_at TEXT NOT NULL,
		sent_at TEXT,
		locked_by TEXT,
		locked_until_at TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS app_settings (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
	`CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id)`,
	`CREATE INDEX IF NOT EXISTS idx_members_user ON conversation_members(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id)`,
	`CREATE INDEX IF NOT EXISTS idx_message_pins_user ON message_pins(user_id, created_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_message_events_dates ON message_events(starts_at, ends_at)`,
	`CREATE INDEX IF NOT EXISTS idx_poll_options_message ON poll_options(message_id, position)`,
	`CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes(message_id)`,
	`CREATE INDEX IF NOT EXISTS idx_receipts_user ON message_receipts(user_id, status)`,
	`CREATE INDEX IF NOT EXISTS idx_file_shares_file ON file_shares(file_id, created_by)`,
	`CREATE INDEX IF NOT EXISTS idx_file_shares_expiry ON file_shares(expires_at)`,
	`CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC)`,
}

func Migrate(database *sql.DB) error {
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for index, statement := range migrations {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("migration %d: %w", index+1, err)
		}
	}
	for _, column := range []struct {
		name       string
		definition string
	}{
		{"is_admin", "INTEGER NOT NULL DEFAULT 0"},
		{"is_manager", "INTEGER NOT NULL DEFAULT 0"},
		{"is_banned", "INTEGER NOT NULL DEFAULT 0"},
		{"banned_reason", "TEXT"},
		{"banned_at", "TEXT"},
		{"avatar", "TEXT"},
		{"description", "TEXT NOT NULL DEFAULT ''"},
		{"recovery_code_hash", "TEXT"},
		{"is_remote", "INTEGER NOT NULL DEFAULT 0"},
		{"remote_instance_id", "INTEGER REFERENCES federated_instances(id)"},
		{"remote_username", "TEXT"},
	} {
		exists, err := columnExists(tx, "users", column.name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := tx.Exec(`ALTER TABLE users ADD COLUMN ` + column.name + ` ` + column.definition); err != nil {
				return fmt.Errorf("add users.%s: %w", column.name, err)
			}
		}
	}
	exists, err := columnExists(tx, "conversations", "encrypted_description")
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.Exec(`ALTER TABLE conversations ADD COLUMN encrypted_description TEXT`); err != nil {
			return fmt.Errorf("add conversations.encrypted_description: %w", err)
		}
	}
	exists, err = columnExists(tx, "conversations", "encrypted_avatar")
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.Exec(`ALTER TABLE conversations ADD COLUMN encrypted_avatar TEXT`); err != nil {
			return fmt.Errorf("add conversations.encrypted_avatar: %w", err)
		}
	}
	exists, err = columnExists(tx, "conversations", "federation_key_id")
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.Exec(`ALTER TABLE conversations ADD COLUMN federation_key_id TEXT`); err != nil {
			return fmt.Errorf("add conversations.federation_key_id: %w", err)
		}
	}
	exists, err = columnExists(tx, "contacts", "status")
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.Exec(`ALTER TABLE contacts ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'`); err != nil {
			return fmt.Errorf("add contacts.status: %w", err)
		}
	}
	exists, err = columnExists(tx, "federated_instances", "host")
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.Exec(`ALTER TABLE federated_instances ADD COLUMN host TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("add federated_instances.host: %w", err)
		}
	}
	for _, column := range []string{"locked_by", "locked_until_at"} {
		exists, err = columnExists(tx, "federation_outbox", column)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := tx.Exec(`ALTER TABLE federation_outbox ADD COLUMN ` + column + ` TEXT`); err != nil {
				return fmt.Errorf("add federation_outbox.%s: %w", column, err)
			}
		}
	}
	if err := backfillFederatedInstanceHosts(tx); err != nil {
		return err
	}
	for _, column := range []struct {
		name       string
		definition string
	}{
		{"expires_at", "TEXT"},
		{"poll_expires_at", "TEXT"},
		{"pinned_by", "INTEGER REFERENCES users(id)"},
		{"pinned_at", "TEXT"},
	} {
		exists, err := columnExists(tx, "messages", column.name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := tx.Exec(`ALTER TABLE messages ADD COLUMN ` + column.name + ` ` + column.definition); err != nil {
				return fmt.Errorf("add messages.%s: %w", column.name, err)
			}
		}
	}
	for _, statement := range []string{
		`CREATE TABLE IF NOT EXISTS message_reactions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			emoji TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(message_id, user_id, emoji)
		)`,
		`CREATE TABLE IF NOT EXISTS message_pins (
			message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			PRIMARY KEY(message_id, user_id)
		)`,
		`CREATE TABLE IF NOT EXISTS message_events (
			message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
			starts_at TEXT NOT NULL,
			ends_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS poll_options (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
			position INTEGER NOT NULL,
			UNIQUE(message_id, position)
		)`,
		`CREATE TABLE IF NOT EXISTS poll_votes (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
			option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TEXT NOT NULL,
			UNIQUE(message_id, user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_remote_users ON users(remote_instance_id, remote_username)`,
		`CREATE INDEX IF NOT EXISTS idx_federated_instances_host ON federated_instances(host)`,
		`CREATE INDEX IF NOT EXISTS idx_federation_outbox_due ON federation_outbox(sent_at, next_attempt_at)`,
		`CREATE INDEX IF NOT EXISTS idx_federation_outbox_ready ON federation_outbox(sent_at, next_attempt_at, locked_until_at)`,
		`CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at)`,
		`CREATE INDEX IF NOT EXISTS idx_message_reactions_message ON message_reactions(message_id)`,
		`CREATE INDEX IF NOT EXISTS idx_message_pins_user ON message_pins(user_id, created_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_message_events_dates ON message_events(starts_at, ends_at)`,
		`CREATE INDEX IF NOT EXISTS idx_poll_options_message ON poll_options(message_id, position)`,
		`CREATE INDEX IF NOT EXISTS idx_poll_votes_message ON poll_votes(message_id)`,
	} {
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("create federation index: %w", err)
		}
	}
	if _, err := tx.Exec(`INSERT OR IGNORE INTO message_pins(message_id,user_id,created_at)
		SELECT id,pinned_by,pinned_at FROM messages
		WHERE pinned_by IS NOT NULL AND pinned_at IS NOT NULL`); err != nil {
		return fmt.Errorf("backfill personal message pins: %w", err)
	}
	if _, err := tx.Exec(`UPDATE users SET is_admin=1
		WHERE id=(SELECT id FROM users ORDER BY id LIMIT 1)
		AND NOT EXISTS(SELECT 1 FROM users WHERE is_admin=1)`); err != nil {
		return fmt.Errorf("ensure initial administrator: %w", err)
	}
	return tx.Commit()
}

func columnExists(tx *sql.Tx, table, column string) (bool, error) {
	rows, err := tx.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, kind string
		var notNull, primaryKey int
		var defaultValue sql.NullString
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func backfillFederatedInstanceHosts(tx *sql.Tx) error {
	rows, err := tx.Query(`SELECT id,base_url FROM federated_instances WHERE host='' OR host IS NULL`)
	if err != nil {
		return fmt.Errorf("list federated instances for host backfill: %w", err)
	}
	defer rows.Close()
	type instance struct {
		id      int64
		baseURL string
	}
	items := []instance{}
	for rows.Next() {
		var item instance
		if err := rows.Scan(&item.id, &item.baseURL); err != nil {
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range items {
		host := federatedInstanceHost(item.baseURL)
		if host == "" {
			continue
		}
		if _, err := tx.Exec(`UPDATE federated_instances SET host=? WHERE id=?`, host, item.id); err != nil {
			return fmt.Errorf("backfill federated_instances.host: %w", err)
		}
	}
	return nil
}

func federatedInstanceHost(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return ""
	}
	return strings.ToLower(parsed.Host)
}
