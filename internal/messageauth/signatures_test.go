package messageauth_test

import (
	"testing"

	"chat-pwa-go/internal/messageauth"
	"chat-pwa-go/internal/testsupport"
)

func TestMessageSignatureAcceptsCanonicalPayloadAndRejectsTampering(t *testing.T) {
	payload := messageauth.Payload{
		Version: messageauth.Version, Kind: "text", ConversationID: "42", SenderID: "7",
		ClientMessageID: "message-test-id-0001", Revision: 1, KeyEpoch: 1,
		EncryptedContent: "ciphertext", IV: "message-iv-value",
	}
	fields := testsupport.Sign(payload)
	input := messageauth.Input{
		ClientMessageID: fields["client_message_id"].(string), SignatureVersion: fields["signature_version"].(int),
		SigningKeyID: fields["signing_key_id"].(string), Signature: fields["signature"].(string), Revision: fields["revision"].(int64),
	}
	if err := messageauth.Verify(testsupport.SigningPublicKey, input, payload); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	tampered := map[string]func(*messageauth.Payload){
		"ciphertext":       func(value *messageauth.Payload) { value.EncryptedContent = "tampered" },
		"conversation":     func(value *messageauth.Payload) { value.ConversationID = "43" },
		"sender":           func(value *messageauth.Payload) { value.SenderID = "8" },
		"kind":             func(value *messageauth.Payload) { value.Kind = "poll" },
		"key epoch":        func(value *messageauth.Payload) { value.KeyEpoch = 2 },
		"reply":            func(value *messageauth.Payload) { value.ReplyTo = "99" },
		"client message":   func(value *messageauth.Payload) { value.ClientMessageID = "message-test-id-0002" },
		"revision":         func(value *messageauth.Payload) { value.Revision = 2 },
		"file digest":      func(value *messageauth.Payload) { value.CiphertextSHA256 = "tampered" },
		"event start time": func(value *messageauth.Payload) { value.StartsAt = "2026-08-09T12:00:00Z" },
	}
	for name, mutate := range tampered {
		t.Run(name, func(t *testing.T) {
			changed := payload
			mutate(&changed)
			if err := messageauth.Verify(testsupport.SigningPublicKey, input, changed); err == nil {
				t.Fatalf("tampered %s was accepted", name)
			}
		})
	}
}

func TestSigningKeyIDIsCanonical(t *testing.T) {
	canonical, keyID, _, err := messageauth.CanonicalPublicKey(testsupport.SigningPublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if canonical != testsupport.SigningPublicKey || keyID != testsupport.SigningKeyID {
		t.Fatalf("canonical=%s keyID=%s", canonical, keyID)
	}
}

func TestWebCryptoP1363SignatureVector(t *testing.T) {
	payload := messageauth.Payload{
		Version: messageauth.Version, Kind: "text", ConversationID: "42", SenderID: "7",
		ClientMessageID: "webcrypto-vector-0001", Revision: 1, KeyEpoch: 1,
		EncryptedContent: "ciphertext", IV: "message-iv-value",
	}
	input := messageauth.Input{
		ClientMessageID: payload.ClientMessageID, SignatureVersion: messageauth.Version,
		SigningKeyID: testsupport.SigningKeyID, Revision: 1,
		// Produced by SubtleCrypto.sign(ECDSA P-256, SHA-256) from the
		// matching test JWK. Web Crypto serializes ECDSA as raw r || s.
		Signature: "QnX1QATupBk9y/DonapOXejawm19c38OtC4wHt4tHJx6yW4iVY/4fOxX52IVuntjDVcSx6mx6p/R2jgfi8Hoow==",
	}
	if err := messageauth.Verify(testsupport.SigningPublicKey, input, payload); err != nil {
		t.Fatalf("Web Crypto signature rejected by the Go verifier: %v", err)
	}
}
