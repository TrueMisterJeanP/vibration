package config

import (
	"strings"
	"testing"
	"time"
)

func TestDatabasePoolDefaultsStayBackwardCompatible(t *testing.T) {
	for _, name := range poolEnvNames {
		t.Setenv(name, "")
	}
	pool, err := databasePool()
	if err != nil {
		t.Fatal(err)
	}
	if pool.MaxOpenConns != 10 || pool.MaxIdleConns != 5 {
		t.Fatalf("default pool sizing changed: %+v", pool)
	}
	if pool.ConnMaxLifetime != 30*time.Minute || pool.ConnMaxIdleTime != 5*time.Minute {
		t.Fatalf("default pool lifetimes changed: %+v", pool)
	}
}

func TestDatabasePoolReadsEnvironment(t *testing.T) {
	t.Setenv("DATABASE_MAX_OPEN_CONNS", "80")
	t.Setenv("DATABASE_MAX_IDLE_CONNS", "40")
	t.Setenv("DATABASE_CONN_MAX_LIFETIME", "10m")
	t.Setenv("DATABASE_CONN_MAX_IDLE_TIME", "90")
	pool, err := databasePool()
	if err != nil {
		t.Fatal(err)
	}
	if pool.MaxOpenConns != 80 || pool.MaxIdleConns != 40 {
		t.Fatalf("pool sizing not applied: %+v", pool)
	}
	if pool.ConnMaxLifetime != 10*time.Minute {
		t.Fatalf("lifetime not applied: %s", pool.ConnMaxLifetime)
	}
	// A bare number is interpreted as seconds.
	if pool.ConnMaxIdleTime != 90*time.Second {
		t.Fatalf("idle time not applied: %s", pool.ConnMaxIdleTime)
	}
}

func TestDatabasePoolRejectsOutOfBoundsValues(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		mustSay string
	}{
		{
			name:    "zero max open",
			env:     map[string]string{"DATABASE_MAX_OPEN_CONNS": "0"},
			mustSay: "DATABASE_MAX_OPEN_CONNS",
		},
		{
			name:    "negative max open",
			env:     map[string]string{"DATABASE_MAX_OPEN_CONNS": "-1"},
			mustSay: "DATABASE_MAX_OPEN_CONNS",
		},
		{
			name:    "absurd max open",
			env:     map[string]string{"DATABASE_MAX_OPEN_CONNS": "100000"},
			mustSay: "DATABASE_MAX_OPEN_CONNS",
		},
		{
			name:    "not a number",
			env:     map[string]string{"DATABASE_MAX_IDLE_CONNS": "many"},
			mustSay: "DATABASE_MAX_IDLE_CONNS",
		},
		{
			name:    "idle above open",
			env:     map[string]string{"DATABASE_MAX_OPEN_CONNS": "10", "DATABASE_MAX_IDLE_CONNS": "11"},
			mustSay: "must not exceed",
		},
		{
			name:    "lifetime too long",
			env:     map[string]string{"DATABASE_CONN_MAX_LIFETIME": "48h"},
			mustSay: "DATABASE_CONN_MAX_LIFETIME",
		},
		{
			name:    "lifetime not a duration",
			env:     map[string]string{"DATABASE_CONN_MAX_LIFETIME": "soon"},
			mustSay: "DATABASE_CONN_MAX_LIFETIME",
		},
		{
			name:    "idle time above lifetime",
			env:     map[string]string{"DATABASE_CONN_MAX_LIFETIME": "1m", "DATABASE_CONN_MAX_IDLE_TIME": "2m"},
			mustSay: "must not exceed",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			for _, name := range poolEnvNames {
				t.Setenv(name, "")
			}
			for name, value := range test.env {
				t.Setenv(name, value)
			}
			_, err := databasePool()
			if err == nil {
				t.Fatal("expected the misconfiguration to be rejected instead of silently falling back")
			}
			if !strings.Contains(err.Error(), test.mustSay) {
				t.Fatalf("error %q does not mention %q", err, test.mustSay)
			}
		})
	}
}

func TestDatabasePoolAcceptsUnlimitedLifetimes(t *testing.T) {
	for _, name := range poolEnvNames {
		t.Setenv(name, "")
	}
	t.Setenv("DATABASE_CONN_MAX_LIFETIME", "0")
	t.Setenv("DATABASE_CONN_MAX_IDLE_TIME", "0")
	pool, err := databasePool()
	if err != nil {
		t.Fatal(err)
	}
	if pool.ConnMaxLifetime != 0 || pool.ConnMaxIdleTime != 0 {
		t.Fatalf("zero must disable the limit: %+v", pool)
	}
}

var poolEnvNames = []string{
	"DATABASE_MAX_OPEN_CONNS",
	"DATABASE_MAX_IDLE_CONNS",
	"DATABASE_CONN_MAX_LIFETIME",
	"DATABASE_CONN_MAX_IDLE_TIME",
}
