package messages

import (
	"sync"
	"time"
)

// expirySweepMaxEntries bounds the sweeper so a server with many conversations
// cannot accumulate one entry per conversation seen since boot.
const expirySweepMaxEntries = 20_000

// expirySweeper rate-limits the physical deletion of expired messages, per
// conversation and per process.
//
// It never affects visibility: expired messages are filtered out by the read
// queries themselves. Skipping a sweep only delays reclaiming rows, and with
// several instances each one sweeps at its own pace, so the cleanup still runs
// at least as often as with a single instance.
type expirySweeper struct {
	mu       sync.Mutex
	interval time.Duration
	sweptAt  map[int64]time.Time
}

func newExpirySweeper(interval time.Duration) *expirySweeper {
	if interval <= 0 {
		interval = expirySweepInterval
	}
	return &expirySweeper{interval: interval, sweptAt: make(map[int64]time.Time)}
}

func (s *expirySweeper) due(conversationID int64, now time.Time) bool {
	if s == nil {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if previous, known := s.sweptAt[conversationID]; known && now.Sub(previous) < s.interval {
		return false
	}
	if len(s.sweptAt) >= expirySweepMaxEntries {
		for id, at := range s.sweptAt {
			if now.Sub(at) >= s.interval {
				delete(s.sweptAt, id)
			}
		}
		if len(s.sweptAt) >= expirySweepMaxEntries {
			s.sweptAt = make(map[int64]time.Time)
		}
	}
	s.sweptAt[conversationID] = now
	return true
}
