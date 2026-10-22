package main

import (
	"strings"
	"testing"
	"time"
)

func TestValidatePassword(t *testing.T) {
	if validatePassword("short") == nil {
		t.Error("expected short password to be rejected")
	}
	if validatePassword(strings.Repeat("x", MaxPasswordLength+1)) == nil {
		t.Error("expected password over bcrypt limit to be rejected")
	}
	if err := validatePassword("twelve-chars"); err != nil {
		t.Errorf("expected 12-char password to be accepted: %v", err)
	}
}

func TestValidateUsername(t *testing.T) {
	for _, ok := range []string{"bob", "alice.smith", "user_1-x"} {
		if err := validateUsername(ok); err != nil {
			t.Errorf("%q: unexpected error %v", ok, err)
		}
	}
	for _, bad := range []string{"", "ab", "<script>", "a b", strings.Repeat("a", 33)} {
		if validateUsername(bad) == nil {
			t.Errorf("%q: expected rejection", bad)
		}
	}
}

func TestValidateEmail(t *testing.T) {
	if err := validateEmail("user@example.org"); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	for _, bad := range []string{"", "no-at", "Name <user@example.org>", "a@b.org, c@d.org", strings.Repeat("a", 250) + "@x.org"} {
		if validateEmail(bad) == nil {
			t.Errorf("%q: expected rejection", bad)
		}
	}
}

func TestHashTokenIsStableAndNotIdentity(t *testing.T) {
	if hashToken("abc") != hashToken("abc") || hashToken("abc") == "abc" || len(hashToken("abc")) != 64 {
		t.Error("unexpected token hash")
	}
}

func TestRateLimiterBlocksAfterThreshold(t *testing.T) {
	l := &rateLimiter{entries: map[string]*limitEntry{}, threshold: 3, window: time.Minute, baseBlock: time.Second, maxBlock: 4 * time.Second}
	for i := 0; i < 2; i++ {
		l.fail("k")
	}
	if l.retryAfter("k") != 0 {
		t.Fatal("blocked before threshold")
	}
	l.fail("k")
	if l.retryAfter("k") == 0 {
		t.Fatal("not blocked at threshold")
	}
	for i := 0; i < 10; i++ {
		l.fail("k")
	}
	if d := l.retryAfter("k"); d > 4*time.Second {
		t.Fatalf("block %v exceeds max", d)
	}
	l.reset("k")
	if l.retryAfter("k") != 0 {
		t.Fatal("still blocked after reset")
	}
}

func TestSqliteDSN(t *testing.T) {
	if got := sqliteDSN("data/nagini.db"); got != "data/nagini.db?_foreign_keys=on" {
		t.Errorf("got %q", got)
	}
	if got := sqliteDSN("file:x.db?cache=shared"); got != "file:x.db?cache=shared&_foreign_keys=on" {
		t.Errorf("got %q", got)
	}
}
