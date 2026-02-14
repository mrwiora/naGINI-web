.PHONY: build clean run test version help minify

# Binary name
BINARY_NAME=nagini-web

# Minification tools
UGLIFYJS=uglifyjs

# Git version information
GIT_DESCRIBE := $(shell git describe --tags --always --dirty 2>/dev/null || echo "unknown")
GIT_TAG := $(shell git describe --tags --exact-match 2>/dev/null)
GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo "unknown")
GIT_DIRTY := $(shell git diff --quiet 2>/dev/null || echo "-dirty")

# Determine version string
# Use git describe which automatically formats as tag-commits-hash-dirty
VERSION := $(GIT_DESCRIBE)

# Build flags
LDFLAGS=-ldflags "-X main.version=$(VERSION)"

help: ## Show this help message
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Available targets:'
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

version: ## Show the version that would be used for build
	@echo "Version: $(VERSION)"
	@echo "Git Tag: $(GIT_TAG)"
	@echo "Git Commit: $(GIT_COMMIT)"
	@echo "Git Dirty: $(GIT_DIRTY)"

minify: ## Minify JavaScript files
	@echo "Minifying JavaScript files..."
	@mkdir -p embedded
	@$(UGLIFYJS) static/app.js -c -m -o embedded/app.min.js
	@$(UGLIFYJS) static/crypto.js -c -m -o embedded/crypto.min.js
	@cp templates/index.html embedded/index.html
	@echo "Minification complete:"
	@echo "  app.js:    $$(du -h static/app.js | cut -f1) -> $$(du -h embedded/app.min.js | cut -f1)"
	@echo "  crypto.js: $$(du -h static/crypto.js | cut -f1) -> $$(du -h embedded/crypto.min.js | cut -f1)"

build: minify ## Build the application with embedded minified files
	@echo "Building $(BINARY_NAME) with version: $(VERSION)"
	go build $(LDFLAGS) -o $(BINARY_NAME) .

run: build ## Build and run the application
	./$(BINARY_NAME)

dev: ## Run the application without building (uses 'dev' version)
	go run .

clean: ## Remove build artifacts
	@echo "Cleaning..."
	rm -f $(BINARY_NAME)
	rm -rf embedded
	go clean

test: ## Run tests
	go test -v ./...

install: build ## Install the binary to $GOPATH/bin
	go install $(LDFLAGS) .

.DEFAULT_GOAL := help
