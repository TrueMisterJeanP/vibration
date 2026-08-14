package userdiscovery

import (
	"regexp"
	"testing"
)

func TestGenerateCodeUsesReadableShortFormat(t *testing.T) {
	code, hash, err := GenerateCode()
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[A-Z2-7]{3}(?:-[A-Z2-7]{4}){3}$`).MatchString(code) {
		t.Fatalf("unexpected discovery code format %q", code)
	}
	if hash == "" || hash != HashCode(code) {
		t.Fatalf("unexpected discovery code hash %q", hash)
	}
}

func TestNormalizeCodeKeepsLegacyCodesCompatible(t *testing.T) {
	shortCode := "K7M-S4WG-BYN5-WZNB"
	if got := NormalizeCode(" k7m s4wg-byn5 wznb "); got != "K7MS4WGBYN5WZNB" {
		t.Fatalf("short code normalization failed: %q", got)
	}
	if got := NormalizeCode("VIB-S4WG-BYN5-WZNB"); got != "VIBS4WGBYN5WZNB" {
		t.Fatalf("previous short code normalization failed: %q", got)
	}
	legacyCode := "VIB-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA"
	if got := NormalizeCode(legacyCode); got != "VIBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" {
		t.Fatalf("legacy code normalization failed: %q", got)
	}
	if NormalizeCode(shortCode+"-AAAA") != "" {
		t.Fatal("an unsupported discovery code length was accepted")
	}
}
