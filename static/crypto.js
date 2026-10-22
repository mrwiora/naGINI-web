/**
 * Crypto.js - Client-side encryption utilities for Nagini
 *
 * Implements AES-256-GCM symmetric encryption using the Web Crypto API.
 * Provides functions for encrypting/decrypting content with a user-provided passphrase.
 */

const NaginiCrypto = {
  /**
   * Minimum passphrase length for new encryptions
   */
  MIN_PASSPHRASE_LENGTH: 12,

  /**
   * Format v2 header: "NGN" + version byte. Authenticated as AES-GCM additional data.
   */
  V2_HEADER: new Uint8Array([0x4e, 0x47, 0x4e, 0x02]),

  /**
   * PBKDF2 iterations for the v2 format and for the legacy headerless format
   */
  V2_ITERATIONS: 600000,
  LEGACY_ITERATIONS: 100000,

  SALT_LENGTH: 16,
  IV_LENGTH: 12,
  TAG_LENGTH: 16,

  /**
   * Validates a passphrase meets security requirements
   * @param {string} passphrase - The passphrase to validate
   * @returns {Object} - {valid: boolean, error: string}
   */
  validatePassphrase(passphrase) {
    if (!passphrase || typeof passphrase !== 'string') {
      return { valid: false, error: 'Passphrase is required' };
    }

    if (passphrase.length < this.MIN_PASSPHRASE_LENGTH) {
      return {
        valid: false,
        error: `Passphrase must be at least ${this.MIN_PASSPHRASE_LENGTH} characters long`
      };
    }

    return { valid: true, error: null };
  },

  /**
   * Derives a cryptographic key from a passphrase using PBKDF2
   * @param {string} passphrase - User's passphrase
   * @param {Uint8Array} salt - Salt for key derivation
   * @param {number} iterations - PBKDF2 iteration count
   * @returns {Promise<CryptoKey>} - Derived encryption key
   */
  async deriveKey(passphrase, salt, iterations) {
    const encoder = new TextEncoder();
    const passphraseBuffer = encoder.encode(passphrase);

    // Import the passphrase as a key for PBKDF2
    const baseKey = await crypto.subtle.importKey(
      'raw',
      passphraseBuffer,
      { name: 'PBKDF2' },
      false,
      ['deriveBits', 'deriveKey']
    );

    // Derive a 256-bit AES-GCM key
    const derivedKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: iterations,
        hash: 'SHA-256'
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    return derivedKey;
  },

  /**
   * Encrypts content using AES-256-GCM (format v2)
   * Output: base64( "NGN" 0x02 || salt[16] || iv[12] || ciphertext+tag )
   * @param {string} content - Plain text content to encrypt
   * @param {string} passphrase - User's passphrase
   * @returns {Promise<string>} - Base64-encoded encrypted data
   */
  async encrypt(content, passphrase) {
    // Validate passphrase
    const validation = this.validatePassphrase(passphrase);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    try {
      const encoder = new TextEncoder();
      const contentBuffer = encoder.encode(content);

      const salt = crypto.getRandomValues(new Uint8Array(this.SALT_LENGTH));
      const iv = crypto.getRandomValues(new Uint8Array(this.IV_LENGTH));
      const key = await this.deriveKey(passphrase, salt, this.V2_ITERATIONS);

      const encryptedBuffer = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv,
          additionalData: this.V2_HEADER,
          tagLength: 128 // 128-bit authentication tag
        },
        key,
        contentBuffer
      );

      const header = this.V2_HEADER;
      const encryptedData = new Uint8Array(encryptedBuffer);
      const combined = new Uint8Array(header.length + salt.length + iv.length + encryptedData.length);
      combined.set(header, 0);
      combined.set(salt, header.length);
      combined.set(iv, header.length + salt.length);
      combined.set(encryptedData, header.length + salt.length + iv.length);

      return this.arrayBufferToBase64(combined);
    } catch (error) {
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt content: ' + error.message);
    }
  },

  /**
   * Decrypts AES-256-GCM encrypted content (format v2, or legacy headerless format)
   * @param {string} encryptedBase64 - Base64-encoded encrypted data
   * @param {string} passphrase - User's passphrase
   * @returns {Promise<string>} - Decrypted plain text content
   */
  async decrypt(encryptedBase64, passphrase) {
    // No minimum length on decrypt: older scripts may use shorter passphrases
    if (!passphrase || typeof passphrase !== 'string') {
      throw new Error('Passphrase is required');
    }

    try {
      let data = this.base64ToArrayBuffer(encryptedBase64.trim());

      let iterations = this.LEGACY_ITERATIONS;
      let additionalData = null;
      const header = this.V2_HEADER;
      if (data.length >= header.length && header.every((b, i) => data[i] === b)) {
        iterations = this.V2_ITERATIONS;
        additionalData = header;
        data = data.slice(header.length);
      }

      if (data.length < this.SALT_LENGTH + this.IV_LENGTH + this.TAG_LENGTH) {
        throw new Error('Encrypted data too short');
      }

      const salt = data.slice(0, this.SALT_LENGTH);
      const iv = data.slice(this.SALT_LENGTH, this.SALT_LENGTH + this.IV_LENGTH);
      const encryptedData = data.slice(this.SALT_LENGTH + this.IV_LENGTH);

      const key = await this.deriveKey(passphrase, salt, iterations);

      const params = { name: 'AES-GCM', iv: iv, tagLength: 128 };
      if (additionalData) {
        params.additionalData = additionalData;
      }
      const decryptedBuffer = await crypto.subtle.decrypt(params, key, encryptedData);

      const decoder = new TextDecoder();
      return decoder.decode(decryptedBuffer);
    } catch (error) {
      console.error('Decryption error:', error);
      if (error.name === 'OperationError' || error.message.includes('decrypt')) {
        throw new Error('Failed to decrypt: Invalid passphrase or corrupted data');
      }
      throw new Error('Failed to decrypt content: ' + error.message);
    }
  },

  /**
   * Converts ArrayBuffer to Base64 string
   * @param {Uint8Array} buffer - Buffer to convert
   * @returns {string} - Base64 encoded string
   */
  arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },

  /**
   * Converts Base64 string to Uint8Array
   * @param {string} base64 - Base64 encoded string
   * @returns {Uint8Array} - Decoded buffer
   */
  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },

  /**
   * Tests if the browser supports required crypto APIs
   * @returns {boolean} - True if crypto is supported
   */
  isSupported() {
    return typeof crypto !== 'undefined' &&
           crypto.subtle &&
           typeof crypto.subtle.encrypt === 'function' &&
           typeof crypto.subtle.decrypt === 'function' &&
           typeof crypto.getRandomValues === 'function';
  },

  /**
   * Displays appropriate error if crypto is not supported
   */
  checkSupport() {
    if (!this.isSupported()) {
      const message = 'Your browser does not support the required cryptographic APIs. ' +
                     'Please use a modern browser (Chrome, Firefox, Safari, or Edge).';
      throw new Error(message);
    }
  }
};

// Ensure crypto is supported when module loads
if (typeof window !== 'undefined') {
  try {
    NaginiCrypto.checkSupport();
  } catch (error) {
    console.error('Crypto module initialization error:', error);
  }
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NaginiCrypto;
}
