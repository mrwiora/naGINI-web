package main

import (
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// rateLimiter blocks a key (IP, username, ...) with exponential backoff after
// too many failures. State is kept in memory only.
type rateLimiter struct {
	mu        sync.Mutex
	entries   map[string]*limitEntry
	threshold int           // failures before blocking starts
	window    time.Duration // failures are forgotten after this much inactivity
	baseBlock time.Duration // first block duration, doubled per further failure
	maxBlock  time.Duration
}

type limitEntry struct {
	failures     int
	last         time.Time
	blockedUntil time.Time
}

func newRateLimiter(threshold int, window, baseBlock, maxBlock time.Duration) *rateLimiter {
	l := &rateLimiter{
		entries:   make(map[string]*limitEntry),
		threshold: threshold,
		window:    window,
		baseBlock: baseBlock,
		maxBlock:  maxBlock,
	}
	go func() {
		for range time.Tick(10 * time.Minute) {
			l.cleanup()
		}
	}()
	return l
}

// retryAfter returns how long the key is still blocked (0 if not blocked)
func (l *rateLimiter) retryAfter(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()

	e, ok := l.entries[key]
	if !ok {
		return 0
	}
	if d := time.Until(e.blockedUntil); d > 0 {
		return d
	}
	return 0
}

// fail records a failure for the key
func (l *rateLimiter) fail(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	e, ok := l.entries[key]
	if !ok || now.Sub(e.last) > l.window {
		e = &limitEntry{}
		l.entries[key] = e
	}
	e.failures++
	e.last = now

	if e.failures >= l.threshold {
		block := l.baseBlock
		for i := l.threshold; i < e.failures && block < l.maxBlock; i++ {
			block *= 2
		}
		if block > l.maxBlock {
			block = l.maxBlock
		}
		e.blockedUntil = now.Add(block)
	}
}

// reset forgets all failures for the key
func (l *rateLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.entries, key)
}

func (l *rateLimiter) cleanup() {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	for key, e := range l.entries {
		if now.Sub(e.last) > l.window && now.After(e.blockedUntil) {
			delete(l.entries, key)
		}
	}
}

var (
	// Login: 5 failures, then 30s, 60s, ... up to 15 minutes
	loginLimiter = newRateLimiter(5, 15*time.Minute, 30*time.Second, 15*time.Minute)
	// Registration: every attempt counts; 5 per hour per IP
	registerLimiter = newRateLimiter(5, time.Hour, 10*time.Minute, time.Hour)
)

// clientIP returns the client address used for rate limiting.
// Behind a reverse proxy, set NAGINI_REAL_IP_HEADER (e.g. "X-Real-IP") to a header
// the proxy sets; otherwise all clients share the proxy's address.
func clientIP(r *http.Request) string {
	if header := os.Getenv("NAGINI_REAL_IP_HEADER"); header != "" {
		if v := r.Header.Get(header); v != "" {
			// For X-Forwarded-For style lists, the last entry was added by our proxy
			parts := strings.Split(v, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
