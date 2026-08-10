package settings

import (
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	database "chat-pwa-go/internal/db"
)

func TestTermsGateAvoidsRepeatedLookupsOnceAccepted(t *testing.T) {
	db := termsTestDB(t)
	gate := NewTermsGate()
	if err := AcceptTerms(db, 1, 1); err != nil {
		t.Fatal(err)
	}
	accepted, version, err := gate.Accepted(db, 1)
	if err != nil || !accepted || version != 1 {
		t.Fatalf("first call accepted=%v version=%d err=%v", accepted, version, err)
	}
	// Removing the row must not change the answer: the positive result for this
	// version is cached, and only a new version can revoke it.
	if _, err := db.Exec(`DELETE FROM user_terms_acceptances WHERE user_id=1`); err != nil {
		t.Fatal(err)
	}
	accepted, _, err = gate.Accepted(db, 1)
	if err != nil || !accepted {
		t.Fatalf("cached acceptance lost: accepted=%v err=%v", accepted, err)
	}
}

// A user who has not accepted must be re-checked on every request, so accepting
// takes effect immediately.
func TestTermsGateDoesNotCacheRefusals(t *testing.T) {
	db := termsTestDB(t)
	gate := NewTermsGate()
	accepted, _, err := gate.Accepted(db, 1)
	if err != nil || accepted {
		t.Fatalf("unexpected initial state accepted=%v err=%v", accepted, err)
	}
	if err := AcceptTerms(db, 1, 1); err != nil {
		t.Fatal(err)
	}
	accepted, _, err = gate.Accepted(db, 1)
	if err != nil || !accepted {
		t.Fatalf("acceptance not observed: accepted=%v err=%v", accepted, err)
	}
}

// Publishing new terms must lock every user out again, cache or not.
func TestTermsGateRechallengesAfterNewTermsArePublished(t *testing.T) {
	db := termsTestDB(t)
	gate := NewTermsGate()
	if err := AcceptTerms(db, 1, 1); err != nil {
		t.Fatal(err)
	}
	if accepted, _, err := gate.Accepted(db, 1); err != nil || !accepted {
		t.Fatalf("setup failed: accepted=%v err=%v", accepted, err)
	}
	if _, changed, err := SaveTerms(db, "Nouvelles conditions d'utilisation pour la campagne de test."); err != nil || !changed {
		t.Fatalf("SaveTerms changed=%v err=%v", changed, err)
	}
	accepted, version, err := gate.Accepted(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if version != 2 {
		t.Fatalf("version=%d, want 2", version)
	}
	if accepted {
		t.Fatal("a user must accept the new terms version again")
	}
}

func TestTermsVersionMatchesLoadTerms(t *testing.T) {
	db := termsTestDB(t)
	version, err := TermsVersion(db)
	if err != nil || version != 1 {
		t.Fatalf("initial version=%d err=%v", version, err)
	}
	if _, _, err := SaveTerms(db, "Des conditions differentes pour verifier la version."); err != nil {
		t.Fatal(err)
	}
	terms, err := LoadTerms(db)
	if err != nil {
		t.Fatal(err)
	}
	version, err = TermsVersion(db)
	if err != nil || version != terms.Version {
		t.Fatalf("TermsVersion=%d LoadTerms=%d err=%v", version, terms.Version, err)
	}
}

func termsTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := db.Exec(`INSERT INTO users(id,username,display_name,password_hash,public_key,encrypted_private_key,crypto_salt,created_at)
		VALUES(1,'terms_user','Terms User','hash','public','private','salt',?)`, now); err != nil {
		t.Fatal(err)
	}
	return db
}
