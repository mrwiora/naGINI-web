package main

import (
	"crypto/sha256"
	"database/sql"
	"embed"

	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"log"
	"net/http"

	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "github.com/mattn/go-sqlite3"
)

//go:embed embedded/index.html
var embeddedTemplate string

//go:embed embedded/app.min.js embedded/crypto.min.js
var embeddedStatic embed.FS

var (
	db            *sql.DB
	templates     *template.Template
	version       = "dev"        // Default version, overridden at build time
	debug         = false        // Debug mode flag
	listenAddress = "127.0.0.1"  // Default listen address
	listenPort    = "8080"       // Default listen port
	publicURL     = ""           // Optional public URL for links
)

// Block represents a script block
type Block struct {
	ID         string    `json:"id"`
	Name       string    `json:"name"`
	Content    string    `json:"content"`
	OrderIndex int       `json:"order_index"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Composition represents a saved composition
type Composition struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	ShortID   string    `json:"short_id"`
	Blocks    []string  `json:"blocks"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// SaveRequest represents the request body for saving compositions
type SaveRequest struct {
	Name   string   `json:"name"`
	Blocks []string `json:"blocks"`
}

// PublishEncryptedRequest represents the request body for publishing encrypted content
type PublishEncryptedRequest struct {
	EncryptedContent string `json:"encrypted_content"`
	CompositionID    string `json:"compositionId,omitempty"`
}

// Script represents a published script
type Script struct {
	ID             int64     `json:"id"`
	Base64Content  string    `json:"base64_content"`
	Checksum       string    `json:"checksum"`
	CompositionID  string    `json:"composition_id,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// GraphData represents graph state data
type GraphData map[string]interface{}

func main() {
	// Parse command-line flags
	var debugFlag bool
	for i, arg := range os.Args[1:] {
		if arg == "-debug" || arg == "--debug" {
			debugFlag = true
			// Remove the flag from os.Args
			os.Args = append(os.Args[:i+1], os.Args[i+2:]...)
			break
		}
	}
	debug = debugFlag

	if debug {
		log.Println("Debug mode enabled")
	}

	// Load configuration from environment variables
	if addr := os.Getenv("NAGINI_LISTENADDRESS"); addr != "" {
		listenAddress = addr
	}
	if port := os.Getenv("NAGINI_LISTENPORT"); port != "" {
		listenPort = port
	}
	if url := os.Getenv("NAGINI_URL"); url != "" {
		publicURL = url
	}

	// Initialize database
	if err := initDB(); err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer db.Close()

	// Load templates from embedded content
	var err error
	templates, err = template.New("index.html").Parse(embeddedTemplate)
	if err != nil {
		log.Fatalf("Failed to load embedded template: %v", err)
	}

	// Get statistics
	blockCount, err := getBlockCount()
	if err != nil {
		log.Printf("Warning: Could not get block count: %v", err)
		blockCount = 0
	}

	compCount, err := getCompositionCount()
	if err != nil {
		log.Printf("Warning: Could not get composition count: %v", err)
		compCount = 0
	}

	// Setup routes
	http.HandleFunc("/api/version", versionHandler)

	// Auth routes
	http.HandleFunc("/api/auth/login", loginHandler)
	http.HandleFunc("/api/auth/logout", logoutHandler)
	http.HandleFunc("/api/auth/me", currentUserHandler)
	http.HandleFunc("/api/auth/register", registerHandler)
	http.HandleFunc("/api/auth/change-password", changePasswordHandler)
	http.HandleFunc("/api/auth/update-email", updateEmailHandler)
	http.HandleFunc("/api/auth/admin-default", adminDefaultPasswordHandler)

	http.HandleFunc("/api/blocks", blocksHandler)
	http.HandleFunc("/api/blocks/", blocksHandler) // Handle /api/blocks/:id
	http.HandleFunc("/api/compositions", compositionsHandler)
	http.HandleFunc("/api/compositions/", compositionsHandler) // Handle /api/compositions/:id
	http.HandleFunc("/api/save", saveCompositionHandler)
	http.HandleFunc("/api/publish-encrypted", publishEncryptedHandler)
	http.HandleFunc("/api/graph/save", saveGraphHandler)
	http.HandleFunc("/api/graph/load/", loadGraphHandler)
	http.HandleFunc("/api/graphs", listGraphsHandler)

	// Serve embedded static files
	staticFS, err := fs.Sub(embeddedStatic, "embedded")
	if err != nil {
		log.Fatalf("Failed to create static file system: %v", err)
	}

	// Custom handler to map requests correctly
	http.HandleFunc("/static/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/static/")
		originalPath := path

		// Map to minified versions
		switch path {
		case "app.js":
			path = "app.min.js"
		case "crypto.js":
			path = "crypto.min.js"
		}

		// Serve the file from embedded FS
		data, err := fs.ReadFile(staticFS, path)
		if err != nil {
			// If file not found in embedded, serve decrypt-example.html from disk
			if path == "decrypt-example.html" {
				http.ServeFile(w, r, "static/decrypt-example.html")
				return
			}
			http.NotFound(w, r)
			return
		}

		if debug {
			log.Printf("Serving embedded file: %s -> %s (%d bytes)", originalPath, path, len(data))
		}

		// Set content type
		contentType := "text/plain"
		if strings.HasSuffix(path, ".js") {
			contentType = "application/javascript"
		} else if strings.HasSuffix(path, ".html") {
			contentType = "text/html"
		} else if strings.HasSuffix(path, ".css") {
			contentType = "text/css"
		}

		w.Header().Set("Content-Type", contentType)
		w.Write(data)
	})

	// Main handler for index and dynamic composition serving
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" {
			indexHandler(w, r)
			return
		}

		// Try to serve published script by short ID
		shortID := strings.TrimPrefix(r.URL.Path, "/")
		if shortID != "" && !strings.HasPrefix(shortID, "api/") && !strings.HasPrefix(shortID, "static/") {
			// Serve as published encrypted script only
			if servePublishedScriptByShortID(w, r, shortID) {
				return
			}
		}

		http.NotFound(w, r)
	})

	// Print startup info
	fmt.Println("============================================================")
	fmt.Println("Nagini Web - Visual Script Composer (Go Edition)")
	fmt.Printf("Version: %s\n", version)
	fmt.Println("============================================================")
	fmt.Printf("Available blocks: %d\n", blockCount)
	fmt.Printf("Available compositions: %d\n", compCount)
	fmt.Println("------------------------------------------------------------")
	fmt.Printf("Listen Address: %s\n", listenAddress)
	fmt.Printf("Listen Port: %s\n", listenPort)
	if publicURL != "" {
		fmt.Printf("Public URL: %s\n", publicURL)
	}
	fmt.Printf("Starting server on http://%s:%s\n", listenAddress, listenPort)
	fmt.Println("============================================================")

	listenAddr := fmt.Sprintf("%s:%s", listenAddress, listenPort)
	log.Fatal(http.ListenAndServe(listenAddr, nil))
}

// indexHandler serves the main page
func indexHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		return
	}
	if err := templates.ExecuteTemplate(w, "index.html", nil); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// versionHandler handles GET /api/version
func versionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{
		"version": version,
	})
}

// blocksHandler handles /api/blocks and /api/blocks/:id endpoints
func blocksHandler(w http.ResponseWriter, r *http.Request) {
	// Extract block ID from path if present
	blockID := strings.TrimPrefix(r.URL.Path, "/api/blocks/")
	blockID = strings.TrimPrefix(blockID, "/api/blocks")
	blockID = strings.Trim(blockID, "/")

	// If no ID, handle collection operations
	if blockID == "" {
		switch r.Method {
		case http.MethodGet:
			blocks, err := getAllBlocks()
			if err != nil {
				respondJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			respondJSON(w, http.StatusOK, blocks)

		case http.MethodPost:
			createBlockHandler(w, r)

		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
		return
	}

	// Handle individual block operations
	switch r.Method {
	case http.MethodGet:
		getBlockHandler(w, r, blockID)
	case http.MethodPut:
		updateBlockHandler(w, r, blockID)
	case http.MethodDelete:
		deleteBlockHandler(w, r, blockID)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// getBlockHandler handles GET /api/block/:id
func getBlockHandler(w http.ResponseWriter, r *http.Request, blockID string) {
	block, err := getBlockByID(blockID)
	if err != nil {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "Block not found"})
		return
	}

	respondJSON(w, http.StatusOK, block)
}

// createBlockHandler handles POST /api/block
func createBlockHandler(w http.ResponseWriter, r *http.Request) {
	// Check if user is admin
	_, err := requireAdmin(r)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Admin access required"})
		return
	}

	var block Block
	if err := json.NewDecoder(r.Body).Decode(&block); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if block.Name == "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Block name is required"})
		return
	}

	// Auto-generate UUID for block ID
	if block.ID == "" {
		block.ID = uuid.New().String()
	}

	if block.OrderIndex == 0 {
		block.OrderIndex = 999
	}

	// Content is already base64 encoded from frontend
	createdBlock, err := createBlock(block.ID, block.Name, block.Content, block.OrderIndex)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	respondJSON(w, http.StatusCreated, map[string]interface{}{
		"success": true,
		"block":   createdBlock,
	})
}

// updateBlockHandler handles PUT /api/block/:id
func updateBlockHandler(w http.ResponseWriter, r *http.Request, blockID string) {
	// Check if user is admin
	_, err := requireAdmin(r)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Admin access required"})
		return
	}

	var updates map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	var name *string
	var content *string
	var orderIndex *int

	if v, ok := updates["name"].(string); ok {
		name = &v
	}
	if v, ok := updates["content"].(string); ok {
		// Content is already base64 encoded from frontend
		content = &v
	}
	if v, ok := updates["order_index"].(float64); ok {
		idx := int(v)
		orderIndex = &idx
	}

	block, err := updateBlock(blockID, name, content, orderIndex)
	if err != nil {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "Block not found"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"block":   block,
	})
}

// deleteBlockHandler handles DELETE /api/block/:id
func deleteBlockHandler(w http.ResponseWriter, r *http.Request, blockID string) {
	// Check if user is admin
	_, err := requireAdmin(r)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Admin access required"})
		return
	}

	success, err := deleteBlock(blockID)
	if err != nil || !success {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "Block not found"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// compositionsHandler handles /api/compositions and /api/compositions/:id endpoints
func compositionsHandler(w http.ResponseWriter, r *http.Request) {
	// Extract composition ID from path if present
	compositionID := strings.TrimPrefix(r.URL.Path, "/api/compositions/")
	compositionID = strings.TrimPrefix(compositionID, "/api/compositions")
	compositionID = strings.Trim(compositionID, "/")

	// If no ID, handle collection operations
	if compositionID == "" {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		compositions, err := getAllCompositions()
		if err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}

		respondJSON(w, http.StatusOK, compositions)
		return
	}

	// Handle individual composition operations
	switch r.Method {
	case http.MethodGet:
		getCompositionHandler(w, r, compositionID)
	case http.MethodDelete:
		deleteCompositionHandler(w, r, compositionID)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}



// getCompositionHandler handles GET /api/composition/:id
func getCompositionHandler(w http.ResponseWriter, r *http.Request, compositionID string) {
	composition, err := getCompositionByID(compositionID)
	if err != nil {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "Composition not found"})
		return
	}

	respondJSON(w, http.StatusOK, composition)
}

// deleteCompositionHandler handles DELETE /api/composition/:id
func deleteCompositionHandler(w http.ResponseWriter, r *http.Request, compositionID string) {
	// Check if user is admin
	_, err := requireAdmin(r)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Admin access required"})
		return
	}

	success, err := deleteComposition(compositionID)
	if err != nil || !success {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "Composition not found"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// saveCompositionHandler handles POST /api/save
func saveCompositionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check if user is admin
	_, err := requireAdmin(r)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Admin access required"})
		return
	}

	var req SaveRequest
	if err = json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if req.Name == "" {
		req.Name = "composition"
	}

	if len(req.Blocks) == 0 {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "No blocks provided"})
		return
	}

	// Check if composition exists
	existing, _ := getCompositionByID(req.Name)

	var composition *Composition

	if existing != nil {
		// Update existing
		composition, err = updateComposition(req.Name, &req.Name, req.Blocks)
	} else {
		// Create new
		composition, err = createComposition(req.Name, req.Name, req.Blocks)
	}

	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"filename": composition.Name,
		"id":       composition.ID,
	})
}

// publishEncryptedHandler handles POST /api/publish-encrypted - publishes pre-encrypted content
func publishEncryptedHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req PublishEncryptedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if req.EncryptedContent == "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "No encrypted content provided"})
		return
	}

	// The content is already encrypted and base64 encoded by the client
	// We just need to store it and generate the checksum
	base64Content := req.EncryptedContent

	// Calculate SHA256 checksum of the encrypted base64 content
	hash := sha256.Sum256([]byte(base64Content))
	checksum := hex.EncodeToString(hash[:])

	// Check if script with this checksum already exists
	existingScript, _ := getScriptByChecksum(checksum)

	var scriptID int64
	if existingScript != nil {
		// Script already published, return existing data
		scriptID = (*existingScript)["id"].(int64)
	} else {
		// Save the encrypted script to database
		scriptID, err := createScript(base64Content, checksum, req.CompositionID)
		if err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to save script: " + err.Error()})
			return
		}
		_ = scriptID // Use the scriptID to avoid unused variable error
	}

	// Get last 8 characters of checksum as short ID
	shortId := checksum[len(checksum)-8:]

	// Build the script URL using short ID (last 8 chars of checksum)
	scriptUrl := fmt.Sprintf("/%s", shortId)

	// Build full URL using public URL if set, otherwise use listen address
	var fullURL string
	if publicURL != "" {
		fullURL = fmt.Sprintf("%s%s", publicURL, scriptUrl)
	} else {
		fullURL = fmt.Sprintf("http://%s:%s%s", listenAddress, listenPort, scriptUrl)
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success":   true,
		"script_id": scriptID,
		"checksum":  checksum,
		"short_id":  shortId,
		"url":       scriptUrl,
		"full_url":  fullURL,
		"encrypted": true,
	})
}

// Graph handlers
// saveGraphHandler handles POST /api/graph/save
// saveGraphHandler handles POST /api/graph/save (backward compatibility)
func saveGraphHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check if user is admin
	_, err := requireAdmin(r)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Admin access required"})
		return
	}

	var req struct {
		Name  string    `json:"name"`
		Graph GraphData `json:"graph"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if req.Name == "" {
		req.Name = "graph"
	}

	filename := req.Name + ".json"
	data, err := json.MarshalIndent(req.Graph, "", "  ")
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	if err := os.WriteFile(filename, data, 0644); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"filename": filename,
	})
}

// loadGraphHandler handles GET /api/graph/load/:id (backward compatibility)
func loadGraphHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	graphID := strings.TrimPrefix(r.URL.Path, "/api/graph/load/")
	if !strings.HasSuffix(graphID, ".json") {
		graphID += ".json"
	}

	data, err := os.ReadFile(graphID)
	if err != nil {
		respondJSON(w, http.StatusNotFound, map[string]string{"error": "Graph not found"})
		return
	}

	var graphData GraphData
	if err := json.Unmarshal(data, &graphData); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	respondJSON(w, http.StatusOK, graphData)
}

// listGraphsHandler handles GET /api/graphs (backward compatibility)
func listGraphsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	files, err := filepath.Glob("*.json")
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	graphs := []map[string]string{}
	for _, file := range files {
		graphs = append(graphs, map[string]string{
			"id":   strings.TrimSuffix(file, ".json"),
			"name": file,
		})
	}

	respondJSON(w, http.StatusOK, graphs)
}

// serveComposition dynamically composes and serves content from block list


// servePublishedScriptByShortID serves a published script by its short ID (last 8 chars of checksum)
// Returns true if script was found and served, false otherwise
func servePublishedScriptByShortID(w http.ResponseWriter, r *http.Request, shortID string) bool {
	// Query for scripts where checksum ends with this short ID
	script, err := getScriptByShortID(shortID)
	if err != nil {
		return false
	}

	// Serve the base64 encoded content as-is
	base64Content := (*script)["base64_content"].(string)

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(base64Content))
	return true
}

// ============================================================================
// Authentication Helpers
// ============================================================================

// getAuthenticatedSession retrieves the session from the request cookie
func getAuthenticatedSession(r *http.Request) (*Session, error) {
	cookie, err := r.Cookie("session_token")
	if err != nil {
		return nil, fmt.Errorf("no session cookie")
	}

	session, err := getSession(cookie.Value)
	if err != nil {
		return nil, fmt.Errorf("invalid session")
	}

	return session, nil
}

// requireAdmin checks if the user is an authenticated admin
func requireAdmin(r *http.Request) (*Session, error) {
	session, err := getAuthenticatedSession(r)
	if err != nil {
		return nil, err
	}

	if session.Role != RoleAdmin {
		return nil, fmt.Errorf("admin access required")
	}

	return session, nil
}

// ============================================================================
// Authentication Handlers
// ============================================================================

// loginHandler handles POST /api/auth/login
func loginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		if debug {
			log.Printf("loginHandler - Failed to decode request body: %v", err)
		}
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if debug {
		log.Printf("loginHandler - Login attempt for user: %s", req.Username)
	}

	// Authenticate user
	user, err := authenticateUser(req.Username, req.Password)
	if err != nil {
		if debug {
			log.Printf("loginHandler - Authentication failed for user %s: %v", req.Username, err)
		}
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid username or password"})
		return
	}

	if debug {
		log.Printf("loginHandler - User authenticated successfully: %s (ID: %d)", user.Username, user.ID)
	}

	// Create session
	session, err := createSession(user.ID)
	if err != nil {
		if debug {
			log.Printf("loginHandler - Failed to create session for user %s: %v", user.Username, err)
		}
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to create session"})
		return
	}

	// Set session cookie
	cookie := &http.Cookie{
		Name:     "session_token",
		Value:    session.Token,
		Path:     "/",
		Expires:  session.ExpiresAt,
		MaxAge:   86400, // 24 hours in seconds
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   true, // Enable for SSL
	}
	http.SetCookie(w, cookie)

	if debug {
		log.Printf("loginHandler - Set session cookie for user %s, token: %s, expires: %v, maxage: %d", user.Username, session.Token, session.ExpiresAt, cookie.MaxAge)
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success":  true,
		"username": user.Username,
		"role":     user.Role,
	})
}

// logoutHandler handles POST /api/auth/logout
func logoutHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get session token from cookie
	cookie, err := r.Cookie("session_token")
	if err == nil {
		deleteSession(cookie.Value)
	}

	// Clear cookie
	http.SetCookie(w, &http.Cookie{
		Name:     "session_token",
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   true,
	})

	if debug {
		log.Printf("logoutHandler - Cleared session cookie")
	}

	respondJSON(w, http.StatusOK, map[string]bool{"success": true})
}

// currentUserHandler handles GET /api/auth/me
func currentUserHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Debug: Log all cookies
	if debug {
		log.Printf("currentUserHandler - All cookies: %v", r.Cookies())
	}

	// Get session token from cookie
	cookie, err := r.Cookie("session_token")
	if err != nil {
		if debug {
			log.Printf("currentUserHandler - No session cookie found: %v", err)
		}
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"authenticated": false,
			"role":          RoleAnonymous,
		})
		return
	}

	if debug {
		log.Printf("currentUserHandler - Found session token: %s", cookie.Value)
	}

	// Get session
	session, err := getSession(cookie.Value)
	if err != nil {
		if debug {
			log.Printf("currentUserHandler - Session validation failed: %v", err)
		}
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"authenticated": false,
			"role":          RoleAnonymous,
		})
		return
	}

	if debug {
		log.Printf("currentUserHandler - Session valid for user: %s", session.Username)
	}

	// Get user email
	var email sql.NullString
	err = db.QueryRow("SELECT email FROM users WHERE id = ?", session.UserID).Scan(&email)
	var userEmail string
	if err == nil && email.Valid {
		userEmail = email.String
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"authenticated": true,
		"username":      session.Username,
		"role":          session.Role,
		"user_id":       session.UserID,
		"email":         userEmail,
	})
}

// registerHandler handles POST /api/auth/register
func registerHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Email    string `json:"email"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if req.Username == "" || req.Password == "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Username and password are required"})
		return
	}

	if req.Email == "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Email address is required"})
		return
	}

	// Create user with 'user' role by default
	err := createUserWithEmail(req.Username, req.Password, req.Email, RoleUser)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint") {
			respondJSON(w, http.StatusConflict, map[string]string{"error": "Username already exists"})
		} else {
			respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to create user"})
		}
		return
	}

	respondJSON(w, http.StatusCreated, map[string]interface{}{
		"success": true,
		"message": "User created successfully",
	})
}

// changePasswordHandler handles POST /api/auth/change-password
func changePasswordHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get session token from cookie
	cookie, err := r.Cookie("session_token")
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	// Get session
	session, err := getSession(cookie.Value)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
		return
	}

	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if req.CurrentPassword == "" || req.NewPassword == "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Current password and new password are required"})
		return
	}

	// Get user to verify current password
	var user User
	var passwordHash string
	err = db.QueryRow(`
		SELECT id, username, password_hash, role
		FROM users
		WHERE id = ?
	`, session.UserID).Scan(&user.ID, &user.Username, &passwordHash, &user.Role)

	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to retrieve user"})
		return
	}

	// Verify current password
	if !verifyPassword(req.CurrentPassword, passwordHash) {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Current password is incorrect"})
		return
	}

	// Update password
	err = updateUserPassword(session.UserID, req.NewPassword)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to update password"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Password changed successfully",
	})
}

// adminDefaultPasswordHandler handles GET /api/auth/admin-default
func adminDefaultPasswordHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Check if admin user still has default password
	var passwordHash string
	err := db.QueryRow(`
		SELECT password_hash FROM users WHERE username = 'admin'
	`).Scan(&passwordHash)

	if err != nil {
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"is_default": false,
		})
		return
	}

	// Check if the password hash matches "admin"
	isDefault := verifyPassword("admin", passwordHash)

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"is_default": isDefault,
	})
}

// updateEmailHandler handles POST /api/auth/update-email
func updateEmailHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get session token from cookie
	cookie, err := r.Cookie("session_token")
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Not authenticated"})
		return
	}

	// Get session
	session, err := getSession(cookie.Value)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]string{"error": "Invalid session"})
		return
	}

	var req struct {
		Email string `json:"email"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}

	if req.Email == "" {
		respondJSON(w, http.StatusBadRequest, map[string]string{"error": "Email address is required"})
		return
	}

	// Update email
	err = updateUserEmail(session.UserID, req.Email)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]string{"error": "Failed to update email"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"success": true,
		"message": "Email updated successfully",
	})
}

// respondJSON writes a JSON response
func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
