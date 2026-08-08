package testsupport

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"

	"chat-pwa-go/internal/messageauth"
)

const (
	SigningPublicKey = `{"kty":"EC","crv":"P-256","x":"i3fTML5ftBlL2htUIlzV2SzKLd1fvi_3aMKPjMVzDo8","y":"2F5kMqoWTYMfjKis6opTOQIhYRV0mxTg--qc80E0QZU"}`
	SigningKeyID     = "f27b5bb7bebc06de0c1d210ce5a302099a568b6ecaec478e3a626d42568a5a90"
	IdentityEnvelope = `{"v":2,"kdf":{"name":"argon2id","version":19,"memory_kib":32768,"iterations":3,"parallelism":1,"hash_length":32,"salt":"AAAAAAAAAAAAAAAAAAAAAA=="},"cipher":{"name":"AES-GCM","iv":"AAAAAAAAAAAAAAAA"},"data":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`
)

func AddIdentity(payload map[string]any) {
	payload["encrypted_private_key"] = IdentityEnvelope
	payload["crypto_salt"] = "argon2id-v2"
	payload["signing_public_key"] = SigningPublicKey
	payload["signing_key_id"] = SigningKeyID
}

func AddIdentityStrings(payload map[string]string) {
	payload["encrypted_private_key"] = IdentityEnvelope
	payload["crypto_salt"] = "argon2id-v2"
	payload["signing_public_key"] = SigningPublicKey
	payload["signing_key_id"] = SigningKeyID
}

func Sign(payload messageauth.Payload) map[string]any {
	privateBytes, _ := base64.RawURLEncoding.DecodeString("0wrbBpHr-HCJFOx1IspTTMjBCiqpPk5OFMAslxZaTiQ")
	d := new(big.Int).SetBytes(privateBytes)
	x, y := elliptic.P256().ScalarBaseMult(privateBytes)
	key := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, D: d}
	canonical, _ := json.Marshal(payload)
	digest := sha256.Sum256(canonical)
	r, s, _ := ecdsa.Sign(rand.Reader, key, digest[:])
	raw := make([]byte, 64)
	r.FillBytes(raw[:32])
	s.FillBytes(raw[32:])
	return map[string]any{
		"client_message_id": payload.ClientMessageID, "signature_version": messageauth.Version,
		"signing_key_id": SigningKeyID, "signature": base64.StdEncoding.EncodeToString(raw), "revision": payload.Revision,
	}
}
