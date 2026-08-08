package groupkeys

import (
	"database/sql"
	"errors"
)

var (
	ErrNotMember        = errors.New("conversation membership changed")
	ErrRotationRequired = errors.New("group key rotation required")
	ErrStaleEpoch       = errors.New("stale group key epoch")
)

// ValidateSend serializes message creation with membership/key rotations by
// taking a write lock on the conversation row before checking the active epoch.
func ValidateSend(tx *sql.Tx, conversationID, userID, requestedEpoch int64) (int64, error) {
	if _, err := tx.Exec(`UPDATE conversations SET current_key_epoch=current_key_epoch WHERE id=?`, conversationID); err != nil {
		return 0, err
	}
	var kind string
	var currentEpoch int64
	var rotationRequired bool
	var activeMembers int
	if err := tx.QueryRow(`SELECT c.type,c.current_key_epoch,c.rotation_required,
		(SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id=c.id AND cm.user_id=? AND cm.role<>'pending')
		FROM conversations c WHERE c.id=?`, userID, conversationID).
		Scan(&kind, &currentEpoch, &rotationRequired, &activeMembers); err != nil {
		return 0, ErrNotMember
	}
	if activeMembers != 1 {
		return 0, ErrNotMember
	}
	if requestedEpoch <= 0 {
		requestedEpoch = 1
	}
	if kind != "group" {
		currentEpoch = 1
		rotationRequired = false
	}
	if rotationRequired {
		return 0, ErrRotationRequired
	}
	if requestedEpoch != currentEpoch {
		return 0, ErrStaleEpoch
	}
	return currentEpoch, nil
}
