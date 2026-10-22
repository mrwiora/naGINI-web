package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var dbPath = "nagini.db"

func init() {
	if p := os.Getenv("NAGINI_DBPATH"); p != "" {
		dbPath = p
	}
}

// sqliteDSN enables foreign key enforcement (ON DELETE CASCADE / SET NULL in the schema)
func sqliteDSN(path string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + "_foreign_keys=on"
}

// initDB initializes the database and creates tables if they don't exist
func initDB() error {
	var err error
	db, err = sql.Open("sqlite3", sqliteDSN(dbPath))
	if err != nil {
		return fmt.Errorf("failed to open database: %w", err)
	}

	// Test connection
	if err := db.Ping(); err != nil {
		return fmt.Errorf("failed to ping database: %w", err)
	}

	// Create blocks table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS blocks (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			content TEXT NOT NULL,
			order_index INTEGER NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create blocks table: %w", err)
	}

	// Create index on order_index
	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_blocks_order
		ON blocks(order_index)
	`)
	if err != nil {
		return fmt.Errorf("failed to create blocks index: %w", err)
	}

	// Create compositions table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS compositions (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			short_id TEXT NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create compositions table: %w", err)
	}

	// Create index on short_id for efficient lookups
	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_compositions_short_id
		ON compositions(short_id)
	`)
	if err != nil {
		return fmt.Errorf("failed to create compositions short_id index: %w", err)
	}

	// Create composition_blocks junction table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS composition_blocks (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			composition_id TEXT NOT NULL,
			block_id TEXT NOT NULL,
			order_index INTEGER NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (composition_id) REFERENCES compositions(id) ON DELETE CASCADE,
			FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create composition_blocks table: %w", err)
	}

	// Create index for efficient composition queries
	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_composition_blocks_comp
		ON composition_blocks(composition_id, order_index)
	`)
	if err != nil {
		return fmt.Errorf("failed to create composition_blocks index: %w", err)
	}

	// Initialize authentication tables
	if err := initAuthTables(); err != nil {
		return fmt.Errorf("failed to initialize auth tables: %w", err)
	}

	// Create scripts table for published compositions
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS scripts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			base64_content TEXT NOT NULL,
			checksum TEXT NOT NULL UNIQUE,
			composition_id TEXT,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			FOREIGN KEY (composition_id) REFERENCES compositions(id) ON DELETE SET NULL
		)
	`)
	if err != nil {
		return fmt.Errorf("failed to create scripts table: %w", err)
	}

	// Create index on checksum for efficient lookups
	_, err = db.Exec(`
		CREATE INDEX IF NOT EXISTS idx_scripts_checksum
		ON scripts(checksum)
	`)
	if err != nil {
		return fmt.Errorf("failed to create scripts checksum index: %w", err)
	}

	// Add tags column to blocks table if it doesn't exist
	_, err = db.Exec(`
		ALTER TABLE blocks ADD COLUMN tags TEXT NOT NULL DEFAULT ''
	`)
	if err != nil && !strings.Contains(err.Error(), "duplicate column") {
		return fmt.Errorf("failed to add tags column: %w", err)
	}

	if err := runMigrations(); err != nil {
		return fmt.Errorf("failed to migrate database: %w", err)
	}

	return nil
}

// runMigrations applies versioned schema changes, tracked in PRAGMA user_version
func runMigrations() error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}

	migrations := []func() error{
		// 1: session tokens are now stored hashed; old plaintext rows can never match
		func() error {
			_, err := db.Exec("DELETE FROM sessions")
			return err
		},
		// 2: unique short_id column for published scripts
		migrateScriptShortIDs,
	}

	for i := version; i < len(migrations); i++ {
		if err := migrations[i](); err != nil {
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		// PRAGMA does not accept bound parameters
		if _, err := db.Exec(fmt.Sprintf("PRAGMA user_version = %d", i+1)); err != nil {
			return err
		}
	}
	return nil
}

// migrateScriptShortIDs adds scripts.short_id and backfills it in creation order, so
// the oldest script keeps the 8-character ID it was reachable under before
func migrateScriptShortIDs() error {
	if _, err := db.Exec("ALTER TABLE scripts ADD COLUMN short_id TEXT"); err != nil &&
		!strings.Contains(err.Error(), "duplicate column") {
		return err
	}

	rows, err := db.Query("SELECT id, checksum FROM scripts WHERE short_id IS NULL ORDER BY id")
	if err != nil {
		return err
	}
	type row struct {
		id       int64
		checksum string
	}
	var pending []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.checksum); err != nil {
			rows.Close()
			return err
		}
		pending = append(pending, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	used := map[string]bool{}
	existing, err := db.Query("SELECT short_id FROM scripts WHERE short_id IS NOT NULL")
	if err != nil {
		return err
	}
	for existing.Next() {
		var id string
		if err := existing.Scan(&id); err != nil {
			existing.Close()
			return err
		}
		used[id] = true
	}
	existing.Close()

	for _, r := range pending {
		shortID := ""
		for n := minShortIDLength; n <= len(r.checksum); n += 4 {
			candidate := r.checksum[len(r.checksum)-n:]
			if !used[candidate] {
				shortID = candidate
				break
			}
		}
		if shortID == "" {
			return fmt.Errorf("no unique short id for script %d", r.id)
		}
		used[shortID] = true
		if _, err := db.Exec("UPDATE scripts SET short_id = ? WHERE id = ?", shortID, r.id); err != nil {
			return err
		}
	}

	_, err = db.Exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_scripts_short_id ON scripts(short_id)")
	return err
}

// ============================================================================
// Block Operations
// ============================================================================

// getAllBlocks returns all blocks ordered by order_index
func getAllBlocks() ([]Block, error) {
	rows, err := db.Query(`
		SELECT id, name, content, tags, order_index, created_at, updated_at
		FROM blocks
		ORDER BY order_index, id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var blocks []Block
	for rows.Next() {
		var block Block
		var createdAt, updatedAt string

		err := rows.Scan(
			&block.ID,
			&block.Name,
			&block.Content,
			&block.Tags,
			&block.OrderIndex,
			&createdAt,
			&updatedAt,
		)
		if err != nil {
			return nil, err
		}

		// Keep content as base64 - frontend will decode
		// Parse timestamps
		block.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
		block.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)

		blocks = append(blocks, block)
	}

	return blocks, rows.Err()
}

// getBlockByID returns a single block by ID
func getBlockByID(blockID string) (*Block, error) {
	var block Block
	var createdAt, updatedAt string

	err := db.QueryRow(`
		SELECT id, name, content, tags, order_index, created_at, updated_at
		FROM blocks
		WHERE id = ?
	`, blockID).Scan(
		&block.ID,
		&block.Name,
		&block.Content,
		&block.Tags,
		&block.OrderIndex,
		&createdAt,
		&updatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("block not found")
	}
	if err != nil {
		return nil, err
	}

	// Keep content as base64 - frontend will decode
	// Parse timestamps
	block.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
	block.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)

	return &block, nil
}

// createBlock creates a new block
func createBlock(blockID, name, content, tags string, orderIndex int) (*Block, error) {
	_, err := db.Exec(`
		INSERT INTO blocks (id, name, content, tags, order_index)
		VALUES (?, ?, ?, ?, ?)
	`, blockID, name, content, tags, orderIndex)

	if err != nil {
		return nil, err
	}

	return getBlockByID(blockID)
}

// updateBlock updates an existing block
func updateBlock(blockID string, name, content, tags *string, orderIndex *int) (*Block, error) {
	updates := []string{}
	args := []interface{}{}

	if name != nil {
		updates = append(updates, "name = ?")
		args = append(args, *name)
	}
	if content != nil {
		updates = append(updates, "content = ?")
		args = append(args, *content)
	}
	if tags != nil {
		updates = append(updates, "tags = ?")
		args = append(args, *tags)
	}
	if orderIndex != nil {
		updates = append(updates, "order_index = ?")
		args = append(args, *orderIndex)
	}

	if len(updates) == 0 {
		return getBlockByID(blockID)
	}

	updates = append(updates, "updated_at = CURRENT_TIMESTAMP")
	args = append(args, blockID)

	query := fmt.Sprintf("UPDATE blocks SET %s WHERE id = ?", strings.Join(updates, ", "))
	_, err := db.Exec(query, args...)
	if err != nil {
		return nil, err
	}

	return getBlockByID(blockID)
}

// deleteBlock deletes a block
func deleteBlock(blockID string) (bool, error) {
	result, err := db.Exec("DELETE FROM blocks WHERE id = ?", blockID)
	if err != nil {
		return false, err
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}

	return rowsAffected > 0, nil
}

// ============================================================================
// Composition Operations
// ============================================================================

// getAllCompositions returns all compositions
func getAllCompositions() ([]map[string]interface{}, error) {
	rows, err := db.Query(`
		SELECT id, name, short_id, created_at, updated_at
		FROM compositions
		ORDER BY updated_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var compositions []map[string]interface{}
	for rows.Next() {
		var id, name, shortID, createdAt, updatedAt string

		err := rows.Scan(&id, &name, &shortID, &createdAt, &updatedAt)
		if err != nil {
			return nil, err
		}

		compositions = append(compositions, map[string]interface{}{
			"id":         id,
			"name":       name,
			"short_id":   shortID,
			"created_at": createdAt,
			"updated_at": updatedAt,
		})
	}

	return compositions, rows.Err()
}

// getCompositionByID returns a composition with its blocks
func getCompositionByID(compositionID string) (*Composition, error) {
	var composition Composition
	var createdAt, updatedAt string

	// Get composition
	err := db.QueryRow(`
		SELECT id, name, short_id, created_at, updated_at
		FROM compositions
		WHERE id = ?
	`, compositionID).Scan(
		&composition.ID,
		&composition.Name,
		&composition.ShortID,
		&createdAt,
		&updatedAt,
	)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("composition not found")
	}
	if err != nil {
		return nil, err
	}

	// Parse timestamps
	composition.CreatedAt, _ = time.Parse("2006-01-02 15:04:05", createdAt)
	composition.UpdatedAt, _ = time.Parse("2006-01-02 15:04:05", updatedAt)

	// Get composition blocks
	rows, err := db.Query(`
		SELECT block_id
		FROM composition_blocks
		WHERE composition_id = ?
		ORDER BY order_index
	`, compositionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	composition.Blocks = []string{}
	for rows.Next() {
		var blockID string
		if err := rows.Scan(&blockID); err != nil {
			return nil, err
		}
		composition.Blocks = append(composition.Blocks, blockID)
	}

	return &composition, rows.Err()
}

// createComposition creates a new composition
func createComposition(compositionID, name string, blockIDs []string) (*Composition, error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Calculate short_id from composed content
	content, err := composeBlocks(blockIDs)
	if err != nil {
		return nil, err
	}

	hash := sha256.Sum256([]byte(content))
	hashHex := hex.EncodeToString(hash[:])
	shortID := hashHex[len(hashHex)-8:]

	// Create composition
	_, err = tx.Exec(`
		INSERT INTO compositions (id, name, short_id)
		VALUES (?, ?, ?)
	`, compositionID, name, shortID)
	if err != nil {
		return nil, err
	}

	// Add blocks to composition
	for idx, blockID := range blockIDs {
		_, err = tx.Exec(`
			INSERT INTO composition_blocks (composition_id, block_id, order_index)
			VALUES (?, ?, ?)
		`, compositionID, blockID, idx)
		if err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return getCompositionByID(compositionID)
}

// updateComposition updates an existing composition
func updateComposition(compositionID string, name *string, blockIDs []string) (*Composition, error) {
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	// Check if composition exists
	var exists int
	err = tx.QueryRow("SELECT 1 FROM compositions WHERE id = ?", compositionID).Scan(&exists)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("composition not found")
	}
	if err != nil {
		return nil, err
	}

	// Update name if provided
	if name != nil {
		_, err = tx.Exec(`
			UPDATE compositions
			SET name = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, *name, compositionID)
	} else {
		_, err = tx.Exec(`
			UPDATE compositions
			SET updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, compositionID)
	}
	if err != nil {
		return nil, err
	}

	// Update blocks if provided
	if blockIDs != nil {
		// Calculate new short_id from composed content
		content, err := composeBlocks(blockIDs)
		if err != nil {
			return nil, err
		}

		hash := sha256.Sum256([]byte(content))
		hashHex := hex.EncodeToString(hash[:])
		shortID := hashHex[len(hashHex)-8:]

		// Update short_id
		_, err = tx.Exec(`
			UPDATE compositions
			SET short_id = ?
			WHERE id = ?
		`, shortID, compositionID)
		if err != nil {
			return nil, err
		}

		// Delete existing blocks
		_, err = tx.Exec(`
			DELETE FROM composition_blocks
			WHERE composition_id = ?
		`, compositionID)
		if err != nil {
			return nil, err
		}

		// Add new blocks
		for idx, blockID := range blockIDs {
			_, err = tx.Exec(`
				INSERT INTO composition_blocks (composition_id, block_id, order_index)
				VALUES (?, ?, ?)
			`, compositionID, blockID, idx)
			if err != nil {
				return nil, err
			}
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return getCompositionByID(compositionID)
}

// deleteComposition deletes a composition
func deleteComposition(compositionID string) (bool, error) {
	result, err := db.Exec("DELETE FROM compositions WHERE id = ?", compositionID)
	if err != nil {
		return false, err
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}

	return rowsAffected > 0, nil
}

// getCompositionByShortID returns a composition by its short ID
func getCompositionByShortID(shortID string) (*Composition, error) {
	var compositionID string

	err := db.QueryRow(`
		SELECT id
		FROM compositions
		WHERE short_id = ?
	`, shortID).Scan(&compositionID)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("composition not found")
	}
	if err != nil {
		return nil, err
	}

	return getCompositionByID(compositionID)
}

// composeBlocks composes multiple blocks into a single output with comment headers
func composeBlocks(blockIDs []string) (string, error) {
	var output strings.Builder

	for _, blockID := range blockIDs {
		// Get block name and content (content is base64 encoded)
		var name, encodedContent string
		err := db.QueryRow("SELECT name, content FROM blocks WHERE id = ?", blockID).Scan(&name, &encodedContent)
		if err == sql.ErrNoRows {
			output.WriteString(fmt.Sprintf("# Block not found: %s\n", blockID))
		} else if err != nil {
			return "", err
		} else {
			// Decode base64 content
			decodedBytes, err := base64.StdEncoding.DecodeString(encodedContent)
			if err != nil {
				return "", fmt.Errorf("failed to decode block content for %s: %v", blockID, err)
			}
			content := string(decodedBytes)

			// Add block name as comment
			output.WriteString(fmt.Sprintf("# %s\n", name))
			output.WriteString(content)
			// Add separator between blocks if content doesn't end with newline
			if content != "" && !strings.HasSuffix(content, "\n") {
				output.WriteString("\n")
			}
		}

		// Add empty line after each block
		output.WriteString("\n")
	}

	return output.String(), nil
}

// ============================================================================
// Script Operations (Published Compositions)
// ============================================================================

// minShortIDLength is the default length of a script's short ID (hex characters)
const minShortIDLength = 8

// createScript creates a new published script and returns its ID and short ID.
// The short ID is the shortest checksum suffix (8, 12, ... chars) not used by another script.
func createScript(base64Content, checksum string, compositionID sql.NullString) (int64, string, error) {
	for n := minShortIDLength; n <= len(checksum); n += 4 {
		shortID := checksum[len(checksum)-n:]
		result, err := db.Exec(`
			INSERT INTO scripts (base64_content, checksum, composition_id, short_id)
			VALUES (?, ?, ?, ?)
		`, base64Content, checksum, compositionID, shortID)
		if err != nil {
			if strings.Contains(err.Error(), "scripts.short_id") {
				continue // suffix collision with another script; try a longer one
			}
			return 0, "", err
		}
		id, err := result.LastInsertId()
		return id, shortID, err
	}
	return 0, "", fmt.Errorf("no unique short id available")
}

// getScriptByChecksum returns a script by its checksum
func getScriptByChecksum(checksum string) (*map[string]interface{}, error) {
	var id int64
	var base64Content, scriptChecksum, compositionID sql.NullString
	var createdAt, updatedAt string

	var shortID sql.NullString
	err := db.QueryRow(`
		SELECT id, base64_content, checksum, composition_id, short_id, created_at, updated_at
		FROM scripts
		WHERE checksum = ?
	`, checksum).Scan(&id, &base64Content, &scriptChecksum, &compositionID, &shortID, &createdAt, &updatedAt)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("script not found")
	}
	if err != nil {
		return nil, err
	}

	script := map[string]interface{}{
		"id":             id,
		"base64_content": base64Content.String,
		"checksum":       scriptChecksum.String,
		"short_id":       shortID.String,
		"created_at":     createdAt,
		"updated_at":     updatedAt,
	}

	if compositionID.Valid {
		script["composition_id"] = compositionID.String
	}

	return &script, nil
}

// getScriptByShortID returns a script by its unique short ID
func getScriptByShortID(shortID string) (*map[string]interface{}, error) {
	var id int64
	var base64Content, scriptChecksum, compositionID sql.NullString
	var createdAt, updatedAt string

	err := db.QueryRow(`
		SELECT id, base64_content, checksum, composition_id, created_at, updated_at
		FROM scripts
		WHERE short_id = ?
	`, shortID).Scan(&id, &base64Content, &scriptChecksum, &compositionID, &createdAt, &updatedAt)

	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("script not found")
	}
	if err != nil {
		return nil, err
	}

	script := map[string]interface{}{
		"id":             id,
		"base64_content": base64Content.String,
		"checksum":       scriptChecksum.String,
		"created_at":     createdAt,
		"updated_at":     updatedAt,
	}

	if compositionID.Valid {
		script["composition_id"] = compositionID.String
	}

	return &script, nil
}

// ============================================================================
// Helper Functions
// ============================================================================

// compositionExists reports whether a composition with the given ID exists
func compositionExists(compositionID string) (bool, error) {
	var exists int
	err := db.QueryRow("SELECT 1 FROM compositions WHERE id = ?", compositionID).Scan(&exists)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// getBlockCount returns the total number of blocks
func getBlockCount() (int, error) {
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM blocks").Scan(&count)
	return count, err
}

// getCompositionCount returns the total number of compositions
func getCompositionCount() (int, error) {
	var count int
	err := db.QueryRow("SELECT COUNT(*) FROM compositions").Scan(&count)
	return count, err
}
