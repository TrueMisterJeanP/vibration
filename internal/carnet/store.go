package carnet

import (
	"database/sql"
	"time"
)

// Ensure records a contact in the owner's carnet without changing the contact
// relation or the conversation itself. The carnet is deliberately separate so
// a user can forget an old entry without deleting application data.
func Ensure(database *sql.DB, ownerID int64, contactIDs ...int64) error {
	if database == nil || ownerID <= 0 {
		return nil
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := database.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, contactID := range contactIDs {
		if contactID <= 0 || contactID == ownerID {
			continue
		}
		if _, err := tx.Exec(`INSERT INTO carnet_entries(owner_id,contact_user_id,created_at)
			SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)
			AND NOT EXISTS(SELECT 1 FROM carnet_entries WHERE owner_id=? AND contact_user_id=?)`,
			ownerID, contactID, now, contactID, ownerID, contactID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// Sync records every accepted member of the user's current private and group
// conversations. Group members are therefore added individually.
func Sync(database *sql.DB, ownerID int64) error {
	if database == nil || ownerID <= 0 {
		return nil
	}
	rows, err := database.Query(`SELECT DISTINCT peer.user_id
		FROM conversation_members mine
		JOIN conversations c ON c.id=mine.conversation_id AND c.type IN ('private','group')
		JOIN conversation_members peer ON peer.conversation_id=mine.conversation_id
		WHERE mine.user_id=? AND mine.role<>'pending' AND peer.user_id<>? AND peer.role<>'pending'`, ownerID, ownerID)
	if err != nil {
		return err
	}
	defer rows.Close()
	contactIDs := make([]int64, 0)
	for rows.Next() {
		var contactID int64
		if err := rows.Scan(&contactID); err != nil {
			return err
		}
		contactIDs = append(contactIDs, contactID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return Ensure(database, ownerID, contactIDs...)
}

func Active(database *sql.DB, ownerID, contactID int64) (bool, error) {
	var count int
	err := database.QueryRow(`SELECT COUNT(*)
		FROM conversation_members mine
		JOIN conversations c ON c.id=mine.conversation_id AND c.type IN ('private','group')
		JOIN conversation_members peer ON peer.conversation_id=mine.conversation_id
		WHERE mine.user_id=? AND mine.role<>'pending' AND peer.user_id=? AND peer.role<>'pending'`,
		ownerID, contactID).Scan(&count)
	return count > 0, err
}
