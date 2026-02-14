package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"fmt"
	"log"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// UserRole represents the role of a user
type UserRole string

const (
	RoleAdmin     UserRole = "admin"
	RoleUser      UserRole = "user"
	RoleAnonymous UserRole = "anonymous"
)

// User represents a user in the system
type User struct {
	ID           int       `json:"id"`
	Username     string    `json:"username"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"` // Never expose in JSON
	Role         UserRole  `json:"role"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Session represents a user session
type Session struct {
	Token     string    `json:"token"`
	UserID    int       `json:"user_id"`
	Username  string    `json:"username"`
	Role      UserRole  `json:"role"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// initAuthTables creates the users and sessions tables
func initAuthTables() error {
	// Create users table
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			email TEXT,
			role TEXT NOT NULL DEFAULT 'user',
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create users table: %w", err)
	}

	// Create sessions table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			token TEXT PRIMARY KEY,
			user_id INTEGER NOT NULL,
			expires_at TIMESTAMP NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create sessions table: %w", err)
	}

	// Create index on sessions for cleanup
	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_sessions_expires
		ON sessions(expires_at)
	`)
	if err != nil {
		return fmt.Errorf("failed to create sessions index: %w", err)
	}

	// Check if admin user exists, if not create one
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM users WHERE role = ?", RoleAdmin).Scan(&count)
	if err != nil {
		return fmt.Errorf("failed to check for admin user: %w", err)
	}

	if count == 0 {
		// Create default admin user with password "admin"
		// NOTE: Users should change this password immediately
		err = createUser("admin", "admin", RoleAdmin)
		if err != nil {
			return fmt.Errorf("failed to create default admin user: %w", err)
		}
		fmt.Println("⚠️  Default admin user created (username: admin, password: admin)")
		fmt.Println("⚠️  Please change the admin password immediately!")
	}

	// Migrate existing users table to add email column if it doesn't exist
	err = migrateUsersTable()
	if err != nil {
		return fmt.Errorf("failed to migrate users table: %w", err)
	}

	return nil
}

// migrateUsersTable adds the email column if it doesn't exist
func migrateUsersTable() error {
	// Check if email column exists
	var columnExists int
	err := db.QueryRow(`
		SELECT COUNT(*) FROM pragma_table_info('users') WHERE name='email'
	`).Scan(&columnExists)

	if err != nil {
		return err
	}

	// Add email column if it doesn't exist
	if columnExists == 0 {
		_, err = db.Exec(`ALTER TABLE users ADD COLUMN email TEXT`)
		if err != nil {
			return err
		}
		fmt.Println("✓ Migrated users table: added email column")
	}

	return nil
}

// hashPassword generates a bcrypt hash of the password
func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// verifyPassword checks if the password matches the hash
func verifyPassword(password, hash string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password))
	return err == nil
}

// generateToken generates a random session token
func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.URLEncoding.EncodeToString(b), nil
}

// createUser creates a new user with hashed password
func createUser(username, password string, role UserRole) error {
	return createUserWithEmail(username, password, "", role)
}

// createUserWithEmail creates a new user with hashed password and email
func createUserWithEmail(username, password, email string, role UserRole) error {
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		INSERT INTO users (username, password_hash, email, role)
		VALUES (?, ?, ?, ?)
	`, username, hash, email, role)

	return err
}

// authenticateUser verifies username and password
func authenticateUser(username, password string) (*User, error) {
	if debug {
		log.Printf("authenticateUser - Attempting to authenticate user: %s", username)
	}

	var user User
	var createdAt, updatedAt string
	var email sql.NullString

	err := db.QueryRow(`
		SELECT id, username, password_hash, email, role, created_at, updated_at
		FROM users
		WHERE username = ?
	`, username).Scan(
		&user.ID,
		&user.Username,
		&user.PasswordHash,
		&email,
		&user.Role,
		&createdAt,
		&updatedAt,
	)

	if email.Valid {
		user.Email = email.String
	}

	if err == sql.ErrNoRows {
		if debug {
			log.Printf("authenticateUser - User not found: %s", username)
		}
		return nil, fmt.Errorf("invalid username or password")
	}
	if err != nil {
		if debug {
			log.Printf("authenticateUser - Database error: %v", err)
		}
		return nil, err
	}

	if debug {
		log.Printf("authenticateUser - User found: %s, role: %s, email: %s", user.Username, user.Role, user.Email)
	}

	// Verify password
	if !verifyPassword(password, user.PasswordHash) {
		if debug {
			log.Printf("authenticateUser - Password verification failed for user: %s", username)
		}
		return nil, fmt.Errorf("invalid username or password")
	}

	if debug {
		log.Printf("authenticateUser - Password verified successfully for user: %s", username)
	}

	// Parse timestamps
	user.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
	user.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)

	return &user, nil
}

// createSession creates a new session for a user
func createSession(userID int) (*Session, error) {
	token, err := generateToken()
	if err != nil {
		if debug {
			log.Printf("createSession - Failed to generate token: %v", err)
		}
		return nil, err
	}

	// Sessions expire after 24 hours
	expiresAt := time.Now().Add(24 * time.Hour)

	if debug {
		log.Printf("createSession - Creating session for userID: %d, token: %s, expires: %v", userID, token, expiresAt)
	}

	_, err = db.Exec(`
		INSERT INTO sessions (token, user_id, expires_at)
		VALUES (?, ?, ?)
	`, token, userID, expiresAt)

	if err != nil {
		if debug {
			log.Printf("createSession - Failed to insert session: %v", err)
		}
		return nil, err
	}

	if debug {
		log.Printf("createSession - Session inserted successfully")
	}

	// Get user info for session
	var username string
	var role UserRole
	err = db.QueryRow(`
		SELECT username, role FROM users WHERE id = ?
	`, userID).Scan(&username, &role)

	if err != nil {
		if debug {
			log.Printf("createSession - Failed to get user info: %v", err)
		}
		return nil, err
	}

	if debug {
		log.Printf("createSession - Session created for user: %s, role: %s", username, role)
	}

	return &Session{
		Token:     token,
		UserID:    userID,
		Username:  username,
		Role:      role,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}, nil
}

// getSession retrieves a session by token
func getSession(token string) (*Session, error) {
	if debug {
		log.Printf("getSession - Looking up token: %s", token)
	}

	var session Session
	var expiresAt, createdAt string

	err := db.QueryRow(`
		SELECT s.token, s.user_id, u.username, u.role, s.expires_at, s.created_at
		FROM sessions s
		JOIN users u ON s.user_id = u.id
		WHERE s.token = ?
	`, token).Scan(
		&session.Token,
		&session.UserID,
		&session.Username,
		&session.Role,
		&expiresAt,
		&createdAt,
	)

	if err == sql.ErrNoRows {
		if debug {
			log.Printf("getSession - Session not found in database")
		}
		return nil, fmt.Errorf("session not found")
	}
	if err != nil {
		if debug {
			log.Printf("getSession - Database error: %v", err)
		}
		return nil, err
	}

	if debug {
		log.Printf("getSession - Found session for user: %s, expires_at string: %s", session.Username, expiresAt)
	}

	// Parse timestamps - try multiple formats
	// SQLite can return timestamps in different formats
	session.ExpiresAt, err = time.Parse(time.RFC3339, expiresAt)
	if err != nil {
		// Try standard format if RFC3339 fails
		session.ExpiresAt, err = time.Parse("2006-01-02 15:04:05", expiresAt)
		if err != nil {
			if debug {
				log.Printf("getSession - Failed to parse expires_at: %v", err)
			}
		}
	}

	session.CreatedAt, err = time.Parse(time.RFC3339, createdAt)
	if err != nil {
		session.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
	}

	if debug {
		log.Printf("getSession - Parsed expiry: %v, current time: %v", session.ExpiresAt, time.Now())
	}

	// Check if session is expired
	if time.Now().After(session.ExpiresAt) {
		if debug {
			log.Printf("getSession - Session expired")
		}
		deleteSession(token)
		return nil, fmt.Errorf("session expired")
	}

	if debug {
		log.Printf("getSession - Session valid, returning user: %s", session.Username)
	}
	return &session, nil
}

// deleteSession deletes a session
func deleteSession(token string) error {
	_, err := db.Exec("DELETE FROM sessions WHERE token = ?", token)
	return err
}

// cleanupExpiredSessions removes expired sessions
func cleanupExpiredSessions() error {
	_, err := db.Exec("DELETE FROM sessions WHERE expires_at < ?", time.Now())
	return err
}

// getAllUsers returns all users (admin only)
func getAllUsers() ([]User, error) {
	rows, err := db.Query(`
		SELECT id, username, email, role, created_at, updated_at
		FROM users
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var user User
		var createdAt, updatedAt string
		var email sql.NullString

		err := rows.Scan(
			&user.ID,
			&user.Username,
			&email,
			&user.Role,
			&createdAt,
			&updatedAt,
		)
		if err != nil {
			return nil, err
		}

		if email.Valid {
			user.Email = email.String
		}

		user.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		user.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)

		users = append(users, user)
	}

	return users, rows.Err()
}

// updateUserPassword updates a user's password
func updateUserPassword(userID int, newPassword string) error {
	hash, err := hashPassword(newPassword)
	if err != nil {
		return err
	}

	_, err = db.Exec(`
		UPDATE users
		SET password_hash = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, hash, userID)

	return err
}

// updateUserRole updates a user's role (admin only)
func updateUserRole(userID int, role UserRole) error {
	_, err := db.Exec(`
		UPDATE users
		SET role = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, role, userID)

	return err
}

// deleteUser deletes a user (admin only)
func deleteUser(userID int) error {
	_, err := db.Exec("DELETE FROM users WHERE id = ?", userID)
	return err
}

// updateUserEmail updates a user's email address
func updateUserEmail(userID int, email string) error {
	_, err := db.Exec(`
		UPDATE users
		SET email = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, email, userID)

	return err
}
