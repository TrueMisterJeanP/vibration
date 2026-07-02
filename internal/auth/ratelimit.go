package auth

import (
	"sync"
	"time"
)

type RateLimiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	buckets map[string]rateBucket
}

type rateBucket struct {
	count   int
	resetAt time.Time
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	return &RateLimiter{limit: limit, window: window, buckets: make(map[string]rateBucket)}
}

func (l *RateLimiter) Allow(key string) bool {
	if l == nil || l.limit <= 0 || l.window <= 0 {
		return true
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()

	bucket := l.buckets[key]
	if bucket.resetAt.IsZero() || now.After(bucket.resetAt) {
		l.buckets[key] = rateBucket{count: 1, resetAt: now.Add(l.window)}
		l.cleanup(now)
		return true
	}
	if bucket.count >= l.limit {
		return false
	}
	bucket.count++
	l.buckets[key] = bucket
	return true
}

func (l *RateLimiter) cleanup(now time.Time) {
	for key, bucket := range l.buckets {
		if now.After(bucket.resetAt) {
			delete(l.buckets, key)
		}
	}
}
