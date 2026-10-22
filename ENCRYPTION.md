# Nagini Web - Script Encryption Guide

## Overview

Nagini Web encrypts published scripts **client-side with AES-256-GCM** before they are uploaded. The
server only stores and serves the ciphertext; `naGINI` on the Arch ISO downloads it, decrypts it with
the passphrase and executes it. If decryption fails, nothing is executed.

## Key Features

- **AES-256-GCM**: authenticated encryption; any modification of the ciphertext is detected
- **Client-Side Processing**: encryption happens in your browser using the Web Crypto API
- **Passphrase Protection**: minimum 12 characters for new scripts; the composer can generate a random 16-character passphrase
- **Passphrase never sent to the server**
- **PBKDF2 Key Derivation**: PBKDF2-HMAC-SHA256 with 600,000 iterations
- **Random Salt & IV**: every encryption uses a fresh random salt and IV
- **Versioned format**: a header identifies the format version and is authenticated

## How It Works

### Publishing an Encrypted Script

1. **Create Your Composition**: Build your script by connecting blocks in the visual composer
2. **Fill Variables**: Complete all required variables (secrets such as account passwords belong here; they only exist inside the ciphertext)
3. **Log in**: publishing requires an account
4. **Enter Passphrase**: enter it twice (minimum 12 characters), or let the composer generate one
5. **Publish**: Click "Encrypt & Publish"

### Encryption Process

```
Block content
    ↓
Variable replacement (in the browser)
    ↓
AES-256-GCM encryption (in the browser)
    ↓
Base64 encoding
    ↓
Published to the server → https://<server>/<short_id>
```

### Running a Published Script with naGINI

```bash
# naGINI prompts for the passphrase (no echo)
nagini -url https://script.example.org/1a2b3c4d

# Non-interactive: pass the passphrase via the environment, not as an argument
NAGINI_PASSPHRASE='...' nagini -disk /dev/sda -interface eth0 -url https://script.example.org/1a2b3c4d
```

`-passphrase` still exists for automation, but its value is visible in the process list.
`naGINI` refuses unencrypted scripts unless `-allow-unencrypted` is given, and refuses `http://` URLs
unless `-insecure-http` is given.

## Encryption Format

### Version 2 (current)

```
base64( "NGN" 0x02 | salt[16] | iv[12] | ciphertext | tag[16] )
```

- **Header**: the 4 bytes `4E 47 4E 02` ("NGN" + version 2), passed to AES-GCM as additional authenticated data
- **Salt**: 16 random bytes for PBKDF2
- **IV**: 12 random bytes
- **Key**: PBKDF2-HMAC-SHA256(passphrase, salt, 600,000 iterations, 32 bytes)
- **Tag**: 128-bit GCM authentication tag, appended to the ciphertext

### Legacy (version 1, decrypt only)

```
base64( salt[16] | iv[12] | ciphertext | tag[16] )
```

No header, no additional data, 100,000 PBKDF2 iterations. Scripts published before the format change
still decrypt in `naGINI`, the browser and the examples below; new scripts are always version 2.

## Decrypting Scripts

### Web-Based Decryption

Open `/static/decrypt-example.html` on your Nagini Web server, paste the encrypted base64 content,
enter the passphrase and click "Decrypt".

### Node.js Decryption

Save this script as `decrypt.js`:

```javascript
const crypto = require('crypto');
const fs = require('fs');

// Supports format v2 ("NGN" 0x02 header, 600k iterations, header as AAD)
// and the legacy headerless format (100k iterations).
function decrypt(encryptedBase64, passphrase) {
    let data = Buffer.from(encryptedBase64.trim(), 'base64');

    const header = Buffer.from([0x4e, 0x47, 0x4e, 0x02]);
    let iterations = 100000;
    let aad = null;
    if (data.subarray(0, 4).equals(header)) {
        iterations = 600000;
        aad = header;
        data = data.subarray(4);
    }

    const salt = data.subarray(0, 16);
    const iv = data.subarray(16, 28);
    const authTag = data.subarray(-16);
    const ciphertext = data.subarray(28, -16);

    const key = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// Usage: node decrypt.js <file-with-encrypted-content>
// The passphrase is read from NAGINI_PASSPHRASE so it does not appear in the process list.
const encryptedContent = fs.readFileSync(process.argv[2], 'utf8');
const passphrase = process.env.NAGINI_PASSPHRASE || '';

try {
    process.stdout.write(decrypt(encryptedContent, passphrase));
} catch (error) {
    console.error('Decryption failed:', error.message);
    process.exit(1);
}
```

**Usage:**
```bash
curl -s https://script.example.org/SHORT_ID > encrypted.txt
read -rs NAGINI_PASSPHRASE && export NAGINI_PASSPHRASE
node decrypt.js encrypted.txt > script.sh

# Review before running
less script.sh
```

### Python Decryption

Requires the `cryptography` package.

```python
import base64
import os
import sys

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

V2_HEADER = b"NGN\x02"


def decrypt(encrypted_base64, passphrase):
    data = base64.b64decode(encrypted_base64.strip())

    # v2: header, 600k iterations, header authenticated as AAD; legacy: no header, 100k
    iterations, aad = 100000, None
    if data.startswith(V2_HEADER):
        iterations, aad = 600000, V2_HEADER
        data = data[len(V2_HEADER):]

    salt, iv, encrypted_data = data[0:16], data[16:28], data[28:]

    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    key = kdf.derive(passphrase.encode("utf-8"))

    # AESGCM expects ciphertext with the 16-byte tag appended, as stored
    return AESGCM(key).decrypt(iv, encrypted_data, aad).decode("utf-8")


# Usage: NAGINI_PASSPHRASE=... python3 decrypt.py encrypted.txt
with open(sys.argv[1]) as f:
    print(decrypt(f.read(), os.environ["NAGINI_PASSPHRASE"]), end="")
```

## Security Considerations

### What This Protects Against

- **Confidentiality**: only holders of the passphrase can read the decrypted script, including the variable values filled in the browser
- **Tampering in storage or transit**: AES-GCM authenticates the ciphertext, so anyone who does not know the passphrase cannot modify or replace the script without decryption failing. `naGINI` refuses to execute anything that does not decrypt when a passphrase is given.
- **Database leaks**: published scripts are only stored encrypted

### What This Does NOT Protect Against

- **A malicious or compromised server**: the server delivers the JavaScript that performs the encryption. Whoever controls the server can change that code to capture passphrases and variables, or to alter scripts before they are encrypted. Block contents are also stored on the server in plaintext; only the filled-in variables and the final script are hidden from an honest server.
- **Authorship**: encryption does not prove who wrote a script. Anyone who knows the passphrase can produce a valid ciphertext.
- **Weak passphrases**: the ciphertext is public to anyone who knows the URL, so passphrases can be guessed offline. Use the generated passphrase or a long passphrase.
- **Compromised passphrase**: anyone with the passphrase can decrypt the script.

### Best Practices

1. **Use the generated passphrase**, or a long passphrase (e.g. `correct-horse-battery-staple-2024`)
2. **Store passphrases securely**, e.g. in a password manager
3. **Serve Nagini Web over HTTPS**; `naGINI` rejects `http://` URLs by default
4. **Review scripts before execution** (`naGINI` shows the decrypted script in interactive mode)
5. **Never echo secrets in scripts**: script output is logged to `/var/log/naGINI_*.log` on the installed system (readable by root only)
6. **Do not reuse passphrases** across scripts

## Technical Specifications

| | |
|---|---|
| Cipher | AES-256-GCM |
| Key length | 256 bits |
| Authentication tag | 128 bits |
| IV length | 96 bits |
| KDF | PBKDF2-HMAC-SHA256 |
| Iterations | 600,000 (v2), 100,000 (legacy) |
| Salt length | 128 bits |
| Additional data | format header `NGN\x02` (v2), none (legacy) |

### Browser Compatibility

Requires the Web Crypto API (all current versions of Chrome, Firefox, Safari and Edge). Web Crypto is
only available in secure contexts: HTTPS or `localhost`.

## Troubleshooting

### "Passphrase must be at least 12 characters long"
New scripts require at least 12 characters. Both passphrase fields must match.

### "Failed to decrypt: Invalid passphrase or corrupted data"
- Verify the passphrase
- Check that the encrypted content was copied completely and not modified

### "Browser does not support required cryptographic APIs"
Use a current browser and open the page via HTTPS or `localhost`.

### Publish button remains disabled
- Both passphrase fields must match and be at least 12 characters
- All blocks must be connected and all variables filled

### "Please log in to publish scripts"
Publishing requires an account. See the README for account setup.

## API Reference

### JavaScript (Client-Side)

```javascript
// Encrypt content (always produces format v2)
const encrypted = await NaginiCrypto.encrypt(content, passphrase);

// Decrypt content (format v2 or legacy)
const decrypted = await NaginiCrypto.decrypt(encryptedBase64, passphrase);

// Validate a passphrase for encryption
const validation = NaginiCrypto.validatePassphrase(passphrase);
// Returns: { valid: boolean, error: string|null }
```

### Server Endpoint

**POST /api/publish-encrypted** (requires a logged-in session)

Request:
```json
{
  "encrypted_content": "base64-encoded-encrypted-data",
  "compositionId": "optional-composition-id"
}
```

The body is limited to 1 MiB, and the content must be valid base64 of at least 44 bytes.

Response:
```json
{
  "success": true,
  "script_id": 123,
  "checksum": "sha256-hash-of-encrypted-content",
  "short_id": "abc12345",
  "url": "/abc12345",
  "full_url": "https://script.example.org/abc12345",
  "encrypted": true
}
```

The short ID is normally the last 8 hex characters of the checksum; if another script already uses that
suffix, it is extended (12, 16, ... characters).

## License

This encryption feature is part of Nagini Web and follows the same license as the main project.
