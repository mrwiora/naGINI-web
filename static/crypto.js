/**
 * Crypto.js - Client-side encryption utilities for Nagini
 *
 * Implements AES-256-GCM symmetric encryption using the Web Crypto API.
 * Provides functions for encrypting/decrypting content with a user-provided passphrase.
 */

const NaginiCrypto = {
  /**
   * Minimum passphrase length requirement
   */
  MIN_PASSPHRASE_LENGTH: 8,

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
   * @returns {Promise<CryptoKey>} - Derived encryption key
   */
  async deriveKey(passphrase, salt) {
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
        iterations: 100000, // High iteration count for security
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
   * Encrypts content using AES-256-GCM
   * @param {string} content - Plain text content to encrypt
   * @param {string} passphrase - User's passphrase
   * @returns {Promise<string>} - Base64-encoded encrypted data with salt and IV
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

      // Generate random salt (16 bytes)
      const salt = crypto.getRandomValues(new Uint8Array(16));

      // Derive encryption key from passphrase and salt
      const key = await this.deriveKey(passphrase, salt);

      // Generate random IV (12 bytes for GCM)
      const iv = crypto.getRandomValues(new Uint8Array(12));

      // Encrypt the content
      const encryptedBuffer = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv,
          tagLength: 128 // 128-bit authentication tag
        },
        key,
        contentBuffer
      );

      // Combine salt + iv + encrypted data
      // Format: [16 bytes salt][12 bytes IV][remaining bytes encrypted data]
      const encryptedData = new Uint8Array(encryptedBuffer);
      const combined = new Uint8Array(salt.length + iv.length + encryptedData.length);
      combined.set(salt, 0);
      combined.set(iv, salt.length);
      combined.set(encryptedData, salt.length + iv.length);

      // Convert to base64
      return this.arrayBufferToBase64(combined);
    } catch (error) {
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt content: ' + error.message);
    }
  },

  /**
   * Decrypts AES-256-GCM encrypted content
   * @param {string} encryptedBase64 - Base64-encoded encrypted data with salt and IV
   * @param {string} passphrase - User's passphrase
   * @returns {Promise<string>} - Decrypted plain text content
   */
  async decrypt(encryptedBase64, passphrase) {
    // Validate passphrase
    const validation = this.validatePassphrase(passphrase);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    try {
      // Decode from base64
      const combined = this.base64ToArrayBuffer(encryptedBase64);

      // Extract salt (first 16 bytes)
      const salt = combined.slice(0, 16);

      // Extract IV (next 12 bytes)
      const iv = combined.slice(16, 28);

      // Extract encrypted data (remaining bytes)
      const encryptedData = combined.slice(28);

      // Derive decryption key from passphrase and salt
      const key = await this.deriveKey(passphrase, salt);

      // Decrypt the content
      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: iv,
          tagLength: 128
        },
        key,
        encryptedData
      );

      // Convert decrypted buffer to string
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
