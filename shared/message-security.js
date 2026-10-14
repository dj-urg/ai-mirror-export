/**
 * Message Security Module
 * 
 * Provides cryptographic message signing and verification to prevent
 * malicious scripts from injecting fake conversation data via postMessage.
 * 
 * Security Features:
 * - HMAC-SHA256 message signing
 * - Timestamp validation to prevent replay attacks
 * - Nonce generation for additional entropy
 */

(function (global) {
  'use strict';

  // Capture critical globals at module load. This module is injected at
  // document_start in both isolated and MAIN worlds; in MAIN world the page
  // can later replace these on `window`, so we freeze references now.
  const _crypto = global.crypto;
  const _subtle = _crypto && _crypto.subtle;
  const _subtleImportKey = _subtle && _subtle.importKey.bind(_subtle);
  const _subtleSign = _subtle && _subtle.sign.bind(_subtle);
  const _getRandomValues = _crypto && _crypto.getRandomValues.bind(_crypto);
  const _TextEncoder = global.TextEncoder;
  const _Uint8Array = global.Uint8Array;
  const _Uint32Array = global.Uint32Array;
  const _JSONstringify = JSON.stringify;
  const _ArrayFrom = Array.from;
  const _DateNow = Date.now.bind(Date);

  // Replay protection. Every signed message carries a random nonce; a nonce
  // is accepted once within the timestamp window and remembered until the
  // window has passed, so a captured message cannot be replayed within the
  // 30 s its timestamp stays valid.
  const _seenNonces = new Map();
  function rememberNonce(nonce, now, maxAge) {
    for (const [n, ts] of _seenNonces) {
      if (now - ts > maxAge) _seenNonces.delete(n);
    }
    if (typeof nonce !== 'string' || nonce.length === 0) return false;
    if (_seenNonces.has(nonce)) return false;
    _seenNonces.set(nonce, now);
    return true;
  }

  /**
   * Generate a cryptographic secret key for message signing
   * This is generated once per page load and shared between inject and content scripts
   * via a secure initialization handshake
   */
  async function generateSecretKey() {
    const array = new _Uint8Array(32);
    _getRandomValues(array);
    return _ArrayFrom(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate HMAC-SHA256 signature for a message
   * @param {string} message - The message to sign (JSON stringified)
   * @param {string} secret - The secret key
   * @returns {Promise<string>} The signature as hex string
   */
  async function signMessage(message, secret) {
    const encoder = new _TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);

    const key = await _subtleImportKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await _subtleSign('HMAC', key, messageData);

    return _ArrayFrom(new _Uint8Array(signature), byte =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  /**
   * Verify HMAC-SHA256 signature for a message
   * @param {string} message - The message to verify (JSON stringified)
   * @param {string} signature - The signature to verify
   * @param {string} secret - The secret key
   * @returns {Promise<boolean>} True if signature is valid
   */
  async function verifySignature(message, signature, secret) {
    const expectedSignature = await signMessage(message, secret);

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expectedSignature.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }

    return result === 0;
  }

  /**
   * Create a signed message for postMessage communication
   * @param {Object} payload - The payload to send
   * @param {string} messageType - The message type
   * @param {string} sourceId - The source identifier
   * @param {string} platform - The platform name
   * @param {string} secret - The secret key
   * @returns {Promise<Object>} The signed message object
   */
  async function createSignedMessage(payload, messageType, sourceId, platform, secret) {
    const timestamp = _DateNow();
    const nonce = _getRandomValues(new _Uint32Array(1))[0].toString(36);

    const messageData = {
      type: messageType,
      payload: payload,
      source: sourceId,
      platform: platform,
      timestamp: timestamp,
      nonce: nonce
    };

    const messageString = _JSONstringify(messageData);
    const signature = await signMessage(messageString, secret);

    // Return the complete signed message
    return {
      ...messageData,
      signature: signature
    };
  }

  /**
   * Verify a signed message received via postMessage
   * @param {Object} message - The received message object
   * @param {string} expectedType - The expected message type
   * @param {string} expectedSource - The expected source identifier
   * @param {string} secret - The secret key
   * @param {number} maxAge - Maximum age of message in milliseconds (default: 30 seconds)
   * @returns {Promise<Object>} Verification result with isValid and error properties
   */
  async function verifySignedMessage(message, expectedType, expectedSource, secret, maxAge = 30000) {
    // Basic structure validation
    if (!message || typeof message !== 'object') {
      return { isValid: false, error: 'Invalid message structure' };
    }

    if (!message.signature || typeof message.signature !== 'string') {
      return { isValid: false, error: 'Missing or invalid signature' };
    }

    if (message.type !== expectedType) {
      return { isValid: false, error: 'Message type mismatch' };
    }

    if (message.source !== expectedSource) {
      return { isValid: false, error: 'Message source mismatch' };
    }

    if (!message.timestamp || typeof message.timestamp !== 'number') {
      return { isValid: false, error: 'Missing or invalid timestamp' };
    }

    const now = _DateNow();
    const age = now - message.timestamp;

    if (age < 0 || age > maxAge) {
      return { isValid: false, error: 'Message timestamp out of valid range' };
    }

    const { signature, ...messageData } = message;
    const messageString = _JSONstringify(messageData);

    // Verify signature
    const isValid = await verifySignature(messageString, signature, secret);

    if (!isValid) {
      return { isValid: false, error: 'Invalid signature' };
    }

    // Reject a replay of an already-accepted message (same nonce).
    if (!rememberNonce(message.nonce, now, maxAge)) {
      return { isValid: false, error: 'Replayed or missing nonce' };
    }

    return { isValid: true, error: null };
  }

  // Export API
  const MessageSecurity = {
    generateSecretKey,
    signMessage,
    verifySignature,
    createSignedMessage,
    verifySignedMessage
  };

  // Export for CommonJS (Node/testing)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MessageSecurity;
  }

  // Export for the browser. inject.js and content.js are separate classic
  // scripts loaded after this file in the same world, so the only way to
  // hand them the API is a window property. Non-enumerable and defined
  // once: the file can be evaluated more than once in a page (Perplexity is
  // injected by manifest and by the scripting API).
  if (typeof window !== 'undefined' && !window.MessageSecurity) {
    try {
      Object.defineProperty(window, 'MessageSecurity', {
        value: MessageSecurity, enumerable: false, configurable: false, writable: false
      });
    } catch (_) {
      window.MessageSecurity = MessageSecurity;
    }
  }

})(typeof window !== 'undefined' ? window : this);


