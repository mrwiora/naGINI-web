# Nagini Web - Visual Script Composer (Go Edition)

A web-based visual script composer for managing and composing code blocks.

## Features

- Create and manage reusable script blocks
- Compose blocks into complete scripts
- Save and load compositions
- Export compositions via URL
- Database-backed storage using SQLite
- User authentication with role-based access (admin, user, anonymous)

## Versioning

The application uses git-dependent versioning:

- **Default version**: `dev` (when running without building, e.g., `go run .`)
- **Built version**: Automatically determined from git state:
  - If on a git tag: uses the tag name (e.g., `v1.0.0`)
  - If not on a tag: uses commit hash with dirty indicator (e.g., `abc1234` or `abc1234-dirty`)

### Building with Version

```bash
# Build with git version
make build

# Check what version will be used
make version

# Run the built binary
./nagini-web
```

### Version Information

The version is displayed:
- On application startup in the console
- Via the API endpoint: `GET /api/version`

Example API response:
```json
{
  "version": "v1.0.0"
}
```

## Authentication

The application includes a user authentication system with three user roles:

- **Admin**: Full access to all features and user management
- **User**: Standard authenticated user
- **Anonymous**: Unauthenticated users (not logged in)

### Default Admin Account

On first startup, a default admin account is created:
- **Username**: `admin`
- **Password**: `admin`

⚠️ **Important**: Change the admin password immediately after first login!

### User Management

- Click the **Login** button in the header to authenticate
- After login, the button shows your username
- Click your username to access **User Settings**:
  - View your account information
  - Change your password
  - Logout

### User Registration

- When the admin password is still default (`admin`), the login modal shows the default credentials
- Once the admin password is changed, the login modal automatically displays a **Register** button
- New users can self-register with standard user privileges
- Registered users have the `user` role (not `admin`)

### Authentication API Endpoints

- `POST /api/auth/login` - Login with username and password
- `POST /api/auth/logout` - Logout current user
- `GET /api/auth/me` - Get current user info
- `POST /api/auth/register` - Register a new user (creates user with 'user' role)
- `POST /api/auth/change-password` - Change current user's password

## Development

### Prerequisites

- Go 1.16 or higher
- Git (for version detection)
- SQLite3

### Running

```bash
# Run without building (uses "dev" version)
make dev

# Or directly with go
go run .

# Build and run
make run

# Run with debug logging enabled
./nagini-web -debug
# or
./nagini-web --debug
```

### Makefile Targets

- `make help` - Show all available targets
- `make build` - Build the application with git version
- `make run` - Build and run the application
- `make dev` - Run without building (dev version)
- `make version` - Show version information
- `make test` - Run tests
- `make clean` - Remove build artifacts
- `make install` - Install to $GOPATH/bin

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with username and password
- `POST /api/auth/logout` - Logout current user
- `GET /api/auth/me` - Get current user info
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/change-password` - Change password

### Application
- `GET /api/version` - Get application version

### Blocks
- `GET /api/blocks` - List all blocks
- `POST /api/block` - Create a new block
- `GET /api/block/:id` - Get a specific block
- `PUT /api/block/:id` - Update a block
- `DELETE /api/block/:id` - Delete a block

### Compositions
- `POST /api/compose` - Preview block composition
- `GET /api/compositions` - List all compositions
- `GET /api/composition/:id` - Get a specific composition
- `DELETE /api/composition/:id` - Delete a composition
- `POST /api/save` - Save a composition
- `POST /api/export` - Export a composition
- `GET /:composition` - Serve a composition as plain text

## Server

The application runs on `http://localhost:5000` by default.

## Debug Mode

Enable verbose logging for authentication and session management:

```bash
./nagini-web -debug
```

Debug mode will log:
- Session creation and validation
- Cookie handling
- Authentication attempts
- Token lookups and expiration checks

This is useful for troubleshooting authentication issues.

## License

[Add your license here]