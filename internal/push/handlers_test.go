package push

import "testing"

func TestNormalizeVAPIDSubject(t *testing.T) {
	tests := map[string]string{
		"admin@example.com":               "admin@example.com",
		" mailto:admin@example.com ":      "admin@example.com",
		"MAILTO:admin@example.com":        "admin@example.com",
		"mailto:mailto:admin@example.com": "admin@example.com",
		"https://example.com/contact":     "https://example.com/contact",
		"":                                "admin@example.com",
	}

	for input, expected := range tests {
		if actual := normalizeVAPIDSubject(input); actual != expected {
			t.Errorf("normalizeVAPIDSubject(%q) = %q; want %q", input, actual, expected)
		}
	}
}
