package httpx

import (
	"bytes"
	"net/http"
	"net/http/httptest"
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

func TestDecodeRejectsTrailingJSON(t *testing.T) {
	var payload struct {
		Name string `json:"name"`
	}
	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewBufferString(`{"name":"first"}{"name":"second"}`))
	response := httptest.NewRecorder()

	if Decode(response, request, &payload) {
		t.Fatal("Decode accepted a body with trailing JSON")
	}
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d", response.Code)
	}
}
