# Nagini Web - Visual Script Composer (Go Edition)

A web-based visual script composer for managing and composing code blocks.

## Features

- Create and manage reusable script blocks
- Compose blocks into complete scripts
- Save and load compositions
- Publish compositions client-side encrypted (AES-256-GCM, see [ENCRYPTION.md](ENCRYPTION.md))
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

### Initial Admin Account

On first startup an `admin` account is created:

- If `NAGINI_ADMIN_PASSWORD` is set (at least 12 characters), it is used as the password.
- Otherwise a random password is generated and printed **once** to stdout (`docker logs` when running in Docker).

Change the password after the first login.

Upgrading from a version that created `admin`/`admin`: if the admin account still uses the password
`admin`, it is replaced on startup by `NAGINI_ADMIN_PASSWORD` or a generated password printed to stdout.

### User Management

- Click the **Login** button in the header to authenticate
- After login, the button shows your username
- Click your username to access **User Settings**:
  - View your account information
  - Change your password (ends all your other sessions)
  - Logout

Passwords must be 12–72 characters. Repeated failed logins are rate limited per IP and per username.

### User Registration

Self-registration is **disabled** by default. Set `NAGINI_ALLOW_REGISTRATION=true` to enable it; the login
modal then shows a **Register** button. Registered users have the `user` role (not `admin`).
Registration attempts are rate limited per IP.

### Roles

- **Anonymous**: browse blocks and compose scripts
- **User**: additionally publish encrypted scripts
- **Admin**: additionally create/edit/delete blocks and save/delete compositions

### Authentication API Endpoints

- `POST /api/auth/login` - Login with username and password
- `POST /api/auth/logout` - Logout current user
- `GET /api/auth/me` - Get current user info
- `POST /api/auth/register` - Register a new user (creates user with 'user' role)
- `POST /api/auth/change-password` - Change current user's password
- `POST /api/auth/update-email` - Change current user's email address

## Development

### Prerequisites

- Go 1.25 or higher
- `uglify-js` (`npm install -g uglify-js`) for `make build`
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
- `GET /api/auth/me` - Get current user info (also reports whether registration is enabled)
- `POST /api/auth/register` - Register a new user (only if `NAGINI_ALLOW_REGISTRATION` is enabled)
- `POST /api/auth/change-password` - Change password
- `POST /api/auth/update-email` - Change email address

### Application
- `GET /api/version` - Get application version

### Blocks
- `GET /api/blocks` - List all blocks
- `POST /api/blocks` - Create a new block (admin)
- `GET /api/blocks/:id` - Get a specific block
- `PUT /api/blocks/:id` - Update a block (admin)
- `DELETE /api/blocks/:id` - Delete a block (admin)

### Compositions
- `GET /api/compositions` - List all compositions
- `GET /api/compositions/:id` - Get a specific composition
- `DELETE /api/compositions/:id` - Delete a composition (admin)
- `POST /api/save` - Save a composition (admin)

### Published scripts
- `POST /api/publish-encrypted` - Publish client-side encrypted content (logged-in users)
- `GET /:short_id` - Serve a published script (base64 ciphertext) as plain text

## Server

The application listens on `http://127.0.0.1:8080` by default.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `NAGINI_LISTENADDRESS` | `127.0.0.1` | Listen address |
| `NAGINI_LISTENPORT` | `8080` | Listen port |
| `NAGINI_URL` | – | Public base URL used in published script links (e.g. `https://script.example.org`) |
| `NAGINI_DBPATH` | `nagini.db` | SQLite database path |
| `NAGINI_ADMIN_PASSWORD` | – | Initial admin password (min. 12 characters); random if unset |
| `NAGINI_ALLOW_REGISTRATION` | `false` | Allow self-registration |
| `NAGINI_REAL_IP_HEADER` | – | Header with the client IP set by your reverse proxy (e.g. `X-Real-IP`), used for rate limiting |

### Deployment notes

- The session cookie is `Secure`: for anything other than `localhost`, serve the application through a
  TLS-terminating reverse proxy. `naGINI` refuses plain `http://` script URLs by default.
- Behind a reverse proxy, set `NAGINI_REAL_IP_HEADER`; otherwise all clients share one rate-limit bucket.
- The server sends a strict Content-Security-Policy; the frontend must not use inline scripts or inline
  event handlers (use `data-click` etc., see `static/ui.js`).

### Docker

The container runs as the unprivileged user `nagini` (uid 100, gid 101) with a read-only root
filesystem (see `docker-compose.yml`). An existing `./data` bind mount created by an older (root)
container must be made writable once:

```bash
sudo chown -R 100:101 ./data
```

## Debug Mode

Enable verbose logging for authentication and session management:

```bash
./nagini-web -debug
```

Debug mode will log:
- Session creation and validation (never token values)
- Authentication attempts (usernames, not passwords)
- Session expiration checks

This is useful for troubleshooting authentication issues.

## License

[Add your license here]