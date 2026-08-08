package messageauth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

const Version = 1

var clientMessageIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,80}$`)

type publicJWK struct {
	KTY string `json:"kty"`
	CRV string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// Payload is serialized as a Go struct on purpose: its JSON member order is the
// cross-client canonical signature format mirrored in web/js/crypto.js.
type Payload struct {
	Version          int    `json:"v"`
	Kind             string `json:"kind"`
	ConversationID   string `json:"conversation_id"`
	SenderID         string `json:"sender_id"`
	ClientMessageID  string `json:"client_message_id"`
	Revision         int64  `json:"revision"`
	KeyEpoch         int64  `json:"key_epoch"`
	ReplyTo          string `json:"reply_to"`
	EncryptedContent string `json:"encrypted_content"`
	IV               string `json:"iv"`
	OptionCount      int    `json:"option_count"`
	StartsAt         string `json:"starts_at"`
	EndsAt           string `json:"ends_at"`
	EncryptedName    string `json:"encrypted_name"`
	EncryptedMIME    string `json:"encrypted_mime"`
	CiphertextSHA256 string `json:"ciphertext_sha256"`
	PreviewSHA256    string `json:"preview_sha256"`
}

type Input struct {
	ClientMessageID  string `json:"client_message_id"`
	SignatureVersion int    `json:"signature_version"`
	SigningKeyID     string `json:"signing_key_id"`
	Signature        string `json:"signature"`
	Revision         int64  `json:"revision"`
}

func NewPayload(kind string, conversationID, senderID int64, input Input, keyEpoch int64, replyTo *int64, encryptedContent, iv string) Payload {
	reply := ""
	if replyTo != nil {
		reply = strconv.FormatInt(*replyTo, 10)
	}
	return Payload{
		Version: Version, Kind: kind,
		ConversationID: strconv.FormatInt(conversationID, 10), SenderID: strconv.FormatInt(senderID, 10),
		ClientMessageID: input.ClientMessageID, Revision: input.Revision, KeyEpoch: keyEpoch, ReplyTo: reply,
		EncryptedContent: encryptedContent, IV: iv,
	}
}

func Canonical(payload Payload) ([]byte, error) {
	return json.Marshal(payload)
}

func CanonicalPublicKey(raw string) (string, string, *ecdsa.PublicKey, error) {
	var jwk publicJWK
	if err := json.Unmarshal([]byte(raw), &jwk); err != nil || jwk.KTY != "EC" || jwk.CRV != "P-256" {
		return "", "", nil, errors.New("invalid signing public key")
	}
	xBytes, errX := base64.RawURLEncoding.DecodeString(jwk.X)
	yBytes, errY := base64.RawURLEncoding.DecodeString(jwk.Y)
	if errX != nil || errY != nil || len(xBytes) != 32 || len(yBytes) != 32 {
		return "", "", nil, errors.New("invalid signing public key")
	}
	x, y := new(big.Int).SetBytes(xBytes), new(big.Int).SetBytes(yBytes)
	if !elliptic.P256().IsOnCurve(x, y) {
		return "", "", nil, errors.New("invalid signing public key")
	}
	canonicalBytes, _ := json.Marshal(publicJWK{KTY: "EC", CRV: "P-256", X: jwk.X, Y: jwk.Y})
	digest := sha256.Sum256(canonicalBytes)
	return string(canonicalBytes), hex.EncodeToString(digest[:]), &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, nil
}

func ValidateInput(input Input) error {
	if input.SignatureVersion != Version || input.Revision < 1 || !clientMessageIDPattern.MatchString(input.ClientMessageID) ||
		len(input.SigningKeyID) != 64 || len(input.Signature) < 80 || len(input.Signature) > 128 {
		return errors.New("invalid message signature")
	}
	return nil
}

func Verify(publicKey string, input Input, payload Payload) error {
	if err := ValidateInput(input); err != nil {
		return err
	}
	_, keyID, key, err := CanonicalPublicKey(publicKey)
	if err != nil || !strings.EqualFold(keyID, input.SigningKeyID) {
		return errors.New("invalid message signing key")
	}
	signature, err := base64.StdEncoding.DecodeString(input.Signature)
	if err != nil || len(signature) != 64 {
		return errors.New("invalid message signature")
	}
	canonical, err := Canonical(payload)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(canonical)
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(key, digest[:], r, s) {
		return errors.New("invalid message signature")
	}
	return nil
}

func SHA256(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}
