package httpx

import (
	"net/http"
	"testing"
)

func TestFrenchErrorMessageTranslatesKnownMessage(t *testing.T) {
	got := frenchErrorMessage(http.StatusUnauthorized, "invalid username or password")
	want := "Nom d’utilisateur ou mot de passe incorrect."
	if got != want {
		t.Fatalf("frenchErrorMessage() = %q, want %q", got, want)
	}
}

func TestFrenchErrorMessageUsesFrenchFallback(t *testing.T) {
	got := frenchErrorMessage(http.StatusInternalServerError, "unexpected english error")
	want := "Une erreur interne est survenue."
	if got != want {
		t.Fatalf("frenchErrorMessage() = %q, want %q", got, want)
	}
}
