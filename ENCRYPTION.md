# Nagini Web - Script Encryption Guide

## Overview

Nagini Web now supports **client-side AES-256-GCM encryption** for published scripts. This feature allows you to encrypt your scripts before they are base64 encoded and published, ensuring that only users with the correct passphrase can decrypt and execute them.

## Key Features

- **AES-256-GCM Encryption**: Industry-standard symmetric encryption with authenticated encryption
- **Client-Side Processing**: Encryption happens entirely in your browser using the Web Crypto API
- **Passphrase Protection**: Scripts are encrypted with a user-provided passphrase (minimum 8 characters)
- **Zero Server-Side Storage**: The passphrase is never sent to or stored on the server
- **PBKDF2 Key Derivation**: Uses 100,000 iterations of PBKDF2-SHA256 for secure key derivation
- **Random Salt & IV**: Each encryption uses a unique random salt and initialization vector

## How It Works

### Publishing an Encrypted Script

1. **Create Your Composition**: Build your script by connecting blocks in the visual composer
2. **Fill Variables**: Complete all required variables
3. **Enter Passphrase**: When all prerequisites are met, you'll see the encryption section with two passphrase fields
4. **Confirm Passphrase**: Enter the same passphrase in both fields (minimum 8 characters)
5. **Publish**: Click "Encrypt & Publish" to encrypt and publish your script

### Encryption Process

```
Original Script Content
    ↓
Variable Replacement
    ↓
Client-Side Encryption (AES-256-GCM)
    ↓
Base64 Encoding
    ↓
Published to Server
```

### Encryption Details

The encryption uses the following format:

```
[16 bytes: Salt][12 bytes: IV][Remaining: Encrypted Data + Auth Tag]
```

- **Salt**: Random 16-byte value for key derivation
- **IV**: Random 12-byte initialization vector for GCM mode
- **Encrypted Data**: AES-256-GCM encrypted content with 128-bit authentication tag
- **Base64**: The entire package is base64 encoded for safe transmission

## Decrypting Scripts

### Web-Based Decryption

Access the decryption tool at: `http://localhost:5001/static/decrypt-example.html`

1. Copy the encrypted base64 content from the published script
2. Paste it into the decryption tool
3. Enter your passphrase
4. Click "Decrypt" to view the original content

### Node.js Decryption

Save this script as `decrypt.js`:

```javascript
const crypto = require('crypto');
const fs = require('fs');

function decrypt(encryptedBase64, passphrase) {
    // Decode from base64
    const combined = Buffer.from(encryptedBase64, 'base64');
    
    // Extract components
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const encryptedData = combined.slice(28);
    
    // Derive key using PBKDF2 (same params as client)
    const key = crypto.pbkdf2Sync(passphrase, salt, 100000, 32, 'sha256');
    
    // Create decipher
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    
    // Extract auth tag (last 16 bytes) and ciphertext
    const authTag = encryptedData.slice(-16);
    const ciphertext = encryptedData.slice(0, -16);
    
    decipher.setAuthTag(authTag);
    
    // Decrypt
    let decrypted = decipher.update(ciphertext, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}

// Usage
const encryptedContent = fs.readFileSync(process.argv[2], 'utf8');
const passphrase = process.argv[3];

try {
    const decrypted = decrypt(encryptedContent, passphrase);
    console.log(decrypted);
} catch (error) {
    console.error('Decryption failed:', error.message);
    process.exit(1);
}
```

**Usage:**
```bash
# Decrypt a script
node decrypt.js encrypted_script.txt "your-passphrase"

# Decrypt and execute
node decrypt.js encrypted_script.txt "your-passphrase" | bash
```

### Command-Line Decryption with cURL

```bash
# Download encrypted script and decrypt
curl -s http://localhost:5001/SHORT_ID > encrypted.txt
node decrypt.js encrypted.txt "your-passphrase"

# One-liner: Download, decrypt, and execute
curl -s http://localhost:5001/SHORT_ID | node decrypt.js /dev/stdin "your-passphrase" | bash
```

### Python Decryption

```python
import base64
import hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend

def decrypt(encrypted_base64, passphrase):
    # Decode from base64
    combined = base64.b64decode(encrypted_base64)
    
    # Extract components
    salt = combined[0:16]
    iv = combined[16:28]
    encrypted_data = combined[28:]
    
    # Derive key using PBKDF2
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
        backend=default_backend()
    )
    key = kdf.derive(passphrase.encode('utf-8'))
    
    # Decrypt using AES-GCM
    aesgcm = AESGCM(key)
    decrypted = aesgcm.decrypt(iv, encrypted_data, None)
    
    return decrypted.decode('utf-8')

# Usage
encrypted_content = "..."  # Your encrypted base64 content
passphrase = "your-passphrase"

try:
    decrypted = decrypt(encrypted_content, passphrase)
    print(decrypted)
except Exception as e:
    print(f"Decryption failed: {e}")
```

## Security Considerations

### ✅ What This Protects Against

- **Confidentiality**: Only users with the correct passphrase can read the script content
- **Eavesdropping**: Scripts are encrypted before transmission over the network
- **Unauthorized Access**: Server administrators cannot read encrypted script contents
- **Data Breach**: If the database is compromised, encrypted scripts remain protected

### ⚠️ What This Does NOT Protect Against

- **Authenticity**: Encryption alone doesn't verify the script's author
- **Integrity**: An attacker could replace the entire encrypted script
- **Man-in-the-Middle**: If serving over HTTP (not HTTPS), attackers could intercept traffic
- **Compromised Passphrase**: If someone obtains your passphrase, they can decrypt the script

### Best Practices

1. **Use Strong Passphrases**: Minimum 8 characters, but longer is better
   - Good: `correct-horse-battery-staple-2024`
   - Bad: `password`

2. **Store Passphrases Securely**: Consider using a password manager

3. **Use HTTPS**: Always serve Nagini Web over HTTPS in production

4. **Review Before Execution**: Always decrypt and review scripts before executing them

5. **Trust Sources**: Only decrypt scripts from trusted sources

6. **Don't Reuse Passphrases**: Use unique passphrases for different scripts

## Technical Specifications

### Encryption Algorithm
- **Cipher**: AES-256-GCM (Galois/Counter Mode)
- **Key Length**: 256 bits
- **Authentication Tag**: 128 bits
- **IV Length**: 12 bytes (96 bits)

### Key Derivation
- **Algorithm**: PBKDF2 with HMAC-SHA256
- **Iterations**: 100,000
- **Salt Length**: 16 bytes (128 bits)
- **Derived Key Length**: 32 bytes (256 bits)

### Browser Compatibility

The encryption feature requires browsers that support the Web Crypto API:

- ✅ Chrome 37+
- ✅ Firefox 34+
- ✅ Safari 11+
- ✅ Edge 79+
- ✅ Opera 24+

## Troubleshooting

### "Passphrase must be at least 8 characters long"
- Ensure your passphrase is at least 8 characters
- Both passphrase fields must match

### "Failed to decrypt: Invalid passphrase or corrupted data"
- Verify you're using the correct passphrase
- Check that the encrypted content wasn't modified or truncated
- Ensure you copied the complete base64 string

### "Browser does not support required cryptographic APIs"
- Update your browser to the latest version
- Try a different modern browser (Chrome, Firefox, Safari, Edge)

### Publish button remains disabled
- Check that both passphrase fields have matching values
- Ensure the passphrase is at least 8 characters
- Verify all other prerequisites are met (connected blocks, filled variables)

## API Reference

### JavaScript (Client-Side)

```javascript
// Encrypt content
const encrypted = await NaginiCrypto.encrypt(content, passphrase);
// Returns: Base64-encoded encrypted content

// Decrypt content
const decrypted = await NaginiCrypto.decrypt(encryptedBase64, passphrase);
// Returns: Original plain text content

// Validate passphrase
const validation = NaginiCrypto.validatePassphrase(passphrase);
// Returns: { valid: boolean, error: string|null }
```

### Server Endpoint

**POST /api/publish-encrypted**

Request:
```json
{
  "encrypted_content": "base64-encoded-encrypted-data",
  "compositionId": "optional-composition-id"
}
```

Response:
```json
{
  "success": true,
  "script_id": 123,
  "checksum": "sha256-hash-of-encrypted-content",
  "short_id": "abc12345",
  "url": "/abc12345",
  "full_url": "http://localhost:5001/abc12345",
  "encrypted": true
}
```

## Examples

### Complete Workflow Example

```bash
# 1. Create and publish encrypted script via UI
# (Use the Nagini Web interface to compose and encrypt)

# 2. Download the published script
curl -s http://localhost:5001/abc12345 > my_encrypted_script.txt

# 3. Decrypt and review
node decrypt.js my_encrypted_script.txt "my-secure-passphrase"

# 4. Decrypt and execute (if trusted)
node decrypt.js my_encrypted_script.txt "my-secure-passphrase" | bash
```

### Automation Example

```bash
#!/bin/bash
# fetch-and-run-encrypted.sh

SCRIPT_URL="http://localhost:5001/abc12345"
PASSPHRASE="$1"

if [ -z "$PASSPHRASE" ]; then
    echo "Usage: $0 <passphrase>"
    exit 1
fi

# Download and decrypt
DECRYPTED=$(curl -s "$SCRIPT_URL" | node decrypt.js /dev/stdin "$PASSPHRASE" 2>&1)

if [ $? -ne 0 ]; then
    echo "Failed to decrypt script"
    exit 1
fi

# Show decrypted content for review
echo "Decrypted script content:"
echo "------------------------"
echo "$DECRYPTED"
echo "------------------------"
read -p "Execute this script? (y/N) " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "$DECRYPTED" | bash
fi
```

## License

This encryption feature is part of Nagini Web and follows the same license as the main project.

## Support

For issues or questions about the encryption feature:
- Check the troubleshooting section above
- Review the decrypt-example.html page for working examples
- Open an issue on the project repository