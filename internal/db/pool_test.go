package db

import (
	"testing"
	"time"
)

func TestPoolNormalizedRepairsInconsistentSettings(t *testing.T) {
	tests := []struct {
		name string
		in   Pool
		want Pool
	}{
		{
			name: "zero falls back to the defaults",
			in:   Pool{},
			want: DefaultPool(),
		},
		{
			name: "idle above open is clamped",
			in:   Pool{MaxOpenConns: 4, MaxIdleConns: 40, ConnMaxLifetime: time.Minute, ConnMaxIdleTime: time.Second},
			want: Pool{MaxOpenConns: 4, MaxIdleConns: 4, ConnMaxLifetime: time.Minute, ConnMaxIdleTime: time.Second},
		},
		{
			name: "idle time above lifetime is clamped",
			in:   Pool{MaxOpenConns: 8, MaxIdleConns: 2, ConnMaxLifetime: time.Minute, ConnMaxIdleTime: time.Hour},
			want: Pool{MaxOpenConns: 8, MaxIdleConns: 2, ConnMaxLifetime: time.Minute, ConnMaxIdleTime: time.Minute},
		},
		{
			name: "negative durations mean unlimited",
			in:   Pool{MaxOpenConns: 8, MaxIdleConns: 2, ConnMaxLifetime: -1, ConnMaxIdleTime: -1},
			want: Pool{MaxOpenConns: 8, MaxIdleConns: 2},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := test.in.normalized(); got != test.want {
				t.Fatalf("normalized() = %+v, want %+v", got, test.want)
			}
		})
	}
}

// TestSQLiteIgnoresPool documents that SQLite keeps its single connection
// whatever the configured pool: the file is opened in a mode that assumes one
// writer.
func TestSQLiteIgnoresPool(t *testing.T) {
	database, err := OpenConfiguredPool("sqlite", t.TempDir()+"/pool.db", "", Pool{MaxOpenConns: 64, MaxIdleConns: 32})
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if got := database.Stats().MaxOpenConnections; got != 1 {
		t.Fatalf("sqlite MaxOpenConnections = %d, want 1", got)
	}
}
