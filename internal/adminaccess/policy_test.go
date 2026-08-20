package adminaccess_test

import (
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"reflect"
	"testing"

	"chat-pwa-go/internal/adminaccess"
	database "chat-pwa-go/internal/db"
)

func TestPolicyModesAndNormalization(t *testing.T) {
	policy, err := adminaccess.Normalize(adminaccess.Policy{
		Mode:       " ALLOWLIST ",
		AllowedIPs: []string{"203.0.113.10", "203.0.113.0/24", "203.0.113.10", "2001:db8::5"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"2001:db8::5", "203.0.113.0/24", "203.0.113.10"}
	if policy.Mode != adminaccess.ModeAllowlist || !reflect.DeepEqual(policy.AllowedIPs, want) {
		t.Fatalf("unexpected normalized policy: %+v", policy)
	}
	for _, value := range []string{"203.0.113.10", "203.0.113.200", "2001:db8::5"} {
		if !policy.Allows(netip.MustParseAddr(value)) {
			t.Fatalf("allowlist rejected %s", value)
		}
	}
	if policy.Allows(netip.MustParseAddr("198.51.100.20")) {
		t.Fatal("allowlist accepted an address outside the configured networks")
	}

	local := adminaccess.Policy{Mode: adminaccess.ModeLocal}
	for _, value := range []string{"127.0.0.1", "10.0.0.8", "192.168.1.20", "172.16.4.2", "::1", "fd00::12", "fe80::1"} {
		if !local.Allows(netip.MustParseAddr(value)) {
			t.Fatalf("local policy rejected %s", value)
		}
	}
	if local.Allows(netip.MustParseAddr("203.0.113.20")) {
		t.Fatal("local policy accepted a public address")
	}
	if _, err := adminaccess.Normalize(adminaccess.Policy{Mode: adminaccess.ModeAllowlist}); err == nil {
		t.Fatal("empty allowlist was accepted")
	}
	if _, err := adminaccess.Normalize(adminaccess.Policy{Mode: adminaccess.ModeAllowlist, AllowedIPs: []string{"not-an-ip"}}); err == nil {
		t.Fatal("invalid allowlist entry was accepted")
	}
}

func TestClientIPOnlyTrustsConfiguredProxyChain(t *testing.T) {
	controller := adminaccess.NewController(nil, []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")})

	untrusted := httptest.NewRequest("GET", "/", nil)
	untrusted.RemoteAddr = "198.51.100.8:443"
	untrusted.Header.Set("X-Forwarded-For", "10.0.0.20")
	address, err := controller.ClientIP(untrusted)
	if err != nil || address.String() != "198.51.100.8" {
		t.Fatalf("untrusted peer spoofed forwarded address: address=%s err=%v", address, err)
	}

	proxied := httptest.NewRequest("GET", "/", nil)
	proxied.RemoteAddr = "127.0.0.1:8080"
	proxied.Header.Set("X-Forwarded-For", "10.0.0.99, 198.51.100.8")
	address, err = controller.ClientIP(proxied)
	if err != nil || address.String() != "198.51.100.8" {
		t.Fatalf("trusted proxy chain address=%s err=%v", address, err)
	}

	invalid := httptest.NewRequest("GET", "/", nil)
	invalid.RemoteAddr = "127.0.0.1:8080"
	invalid.Header.Set("X-Forwarded-For", "invalid")
	if _, err := controller.ClientIP(invalid); err == nil {
		t.Fatal("invalid trusted proxy header was accepted")
	}
}

func TestPolicyPersistsWithUnrestrictedDefault(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "chat.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	initial, err := adminaccess.Load(db)
	if err != nil || initial.Mode != adminaccess.ModeAll {
		t.Fatalf("default policy=%+v err=%v", initial, err)
	}
	saved, err := adminaccess.Save(db, adminaccess.Policy{Mode: adminaccess.ModeAllowlist, AllowedIPs: []string{"203.0.113.25"}})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := adminaccess.Load(db)
	if err != nil || !reflect.DeepEqual(loaded, saved) {
		t.Fatalf("loaded policy=%+v saved=%+v err=%v", loaded, saved, err)
	}
}
