/**
 * Claude Platform - Content Script
 * 
 * This script:
 * 1. Injects inject.js into the page context
 * 2. Listens for conversation data via window.postMessage
 * 3. Forwards the data to the background script for processing
 */

(function () {
  'use strict';

  const PLATFORM = 'Claude';
  const MESSAGE_TYPE = 'CLAUDE_CONVERSATION_DATA';
  const SOURCE_ID = 'claude-exporter-inject';

  // Logging configuration
  const DEBUG_MODE = false; // Set to true for development, false for production

  // Memory management configuration
  const MAX_STORED_CONVERSATIONS = 50;
  const MAX_CONVERSATION_AGE_MS = 3600000; // 1 hour
  const CLEANUP_INTERVAL_MS = 300000; // 5 minutes

  // Store captured conversations in memory with timestamps
  const capturedConversations = new Map();
  const conversationTimestamps = new Map();

  // Generate a cryptographic secret for message signing
  const SECRET_KEY = generateSecretKey();

  /**
   * Redact sensitive information from log data
   */
  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const redacted = Array.isArray(data) ? [...data] : { ...data };

    if (redacted.conversationId && typeof redacted.conversationId === 'string') {
      redacted.conversationId = redacted.conversationId.substring(0, 8) + '...';
    }
    if (redacted.conversation_id && typeof redacted.conversation_id === 'string') {
      redacted.conversation_id = redacted.conversation_id.substring(0, 8) + '...';
    }
    if (redacted.id && typeof redacted.id === 'string' && redacted.id.length > 16) {
      redacted.id = redacted.id.substring(0, 8) + '...';
    }
    if (redacted.uuid && typeof redacted.uuid === 'string') {
      redacted.uuid = redacted.uuid.substring(0, 8) + '...';
    }

    return redacted;
  }

  function logDebug(message, data = null) {
    if (!DEBUG_MODE) return;
    if (data) {
      console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data));
    } else {
      console.log(`[${PLATFORM}] [DEBUG]`, message);
    }
  }

  function logInfo(message, data = null) {
    if (data) {
      console.log(`[${PLATFORM}]`, message, redactSensitiveData(data));
    } else {
      console.log(`[${PLATFORM}]`, message);
    }
  }

  function logWarn(message, data = null) {
    if (data) {
      console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data));
    } else {
      console.warn(`[${PLATFORM}] [WARN]`, message);
    }
  }

  function logError(message, data = null) {
    if (data) {
      console.error(`[${PLATFORM}] [ERROR]`, message, redactSensitiveData(data));
    } else {
      console.error(`[${PLATFORM}] [ERROR]`, message);
    }
  }

  /**
   * Generate a cryptographic secret key
   */
  function generateSecretKey() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Store conversation with memory management
   * Implements LRU (Least Recently Used) eviction when limit is reached
   */
  function storeConversation(id, data) {
    // Clean up oldest conversation if at limit
    if (capturedConversations.size >= MAX_STORED_CONVERSATIONS) {
      // Find oldest conversation by timestamp
      let oldestId = null;
      let oldestTime = Infinity;

      for (const [convId, timestamp] of conversationTimestamps.entries()) {
        if (timestamp < oldestTime) {
          oldestTime = timestamp;
          oldestId = convId;
        }
      }

      if (oldestId) {
        capturedConversations.delete(oldestId);
        conversationTimestamps.delete(oldestId);
        logDebug('Memory limit reached. Evicted oldest conversation', { conversationId: oldestId });
      }
    }

    // Store conversation with current timestamp
    capturedConversations.set(id, data);
    conversationTimestamps.set(id, Date.now());
  }

  /**
   * Clean up old conversations based on age
   */
  function cleanupOldConversations() {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [id, timestamp] of conversationTimestamps.entries()) {
      if (now - timestamp > MAX_CONVERSATION_AGE_MS) {
        capturedConversations.delete(id);
        conversationTimestamps.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logDebug(`Cleaned up ${cleanedCount} old conversation(s)`, { remaining: capturedConversations.size });
    }
  }

  // Start periodic cleanup
  setInterval(cleanupOldConversations, CLEANUP_INTERVAL_MS);

  /**
   * Verify HMAC-SHA256 signature
   */
  async function verifySignature(message, signature, secret) {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);

    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const expectedSig = await crypto.subtle.sign('HMAC', key, messageData);
    const expectedHex = Array.from(new Uint8Array(expectedSig), byte =>
      byte.toString(16).padStart(2, '0')
    ).join('');

    // Constant-time comparison
    if (signature.length !== expectedHex.length) return false;
    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return result === 0;
  }

  /**
   * Inject secret key into page for inject.js to use
   */
  function injectSecretIntoPage() {
    const secretElement = document.createElement('meta');
    secretElement.name = 'claude-exporter-secret';
    secretElement.content = SECRET_KEY;
    secretElement.style.display = 'none';
    (document.head || document.documentElement).appendChild(secretElement);
  }

  // Inject secret as early as possible
  injectSecretIntoPage();

  /**
   * Listen for messages from the injected page script
   */
  window.addEventListener('message', async event => {
    // Only accept messages from the same window
    if (event.source !== window) return;

    // Only accept our specific message type
    if (!event.data || event.data.type !== MESSAGE_TYPE) return;

    // Verify source
    if (event.data.source !== SOURCE_ID) {
      logWarn('Message source mismatch', { source: event.data.source });
      return;
    }

    // Verify signature
    if (!event.data.signature || !event.data.timestamp || !event.data.nonce) {
      logWarn('Message missing security fields');
      return;
    }

    // Verify timestamp (prevent replay attacks - max 30 seconds old)
    const now = Date.now();
    const age = now - event.data.timestamp;
    if (age < 0 || age > 30000) {
      logWarn('Message timestamp out of valid range');
      return;
    }

    // Verify signature
    const { signature, ...messageData } = event.data;
    const messageString = JSON.stringify(messageData);
    const isValid = await verifySignature(messageString, signature, SECRET_KEY);

    if (!isValid) {
      logWarn('Invalid message signature - possible injection attempt');
      return;
    }

    logDebug('Message signature verified');

    const conversationData = event.data.payload;

    if (!conversationData) {
      logWarn('Received message with no payload');
      return;
    }

    if (!conversationData.chat_messages) {
      logWarn('Received conversation data without chat_messages');
      return;
    }

    // Extract conversation UUID
    const conversationId = conversationData.uuid || 'unknown';

    // Store in memory with memory management
    storeConversation(conversationId, conversationData);

    logDebug('Stored conversation data', {
      conversationId: conversationId,
      messageCount: conversationData.chat_messages.length,
      conversationName: conversationData.name || 'Untitled',
      totalCaptured: capturedConversations.size
    });

    // AUTOMATIC DOWNLOAD DISABLED FOR POLICY COMPLIANCE
    // Data is stored in memory (capturedConversations) and waits for manual export via popup
    logDebug('Conversation data captured and stored in memory', { conversationId });

    // Notify popup that conversation data is ready (event-driven update)
    browser.runtime.sendMessage({
      type: 'CONVERSATION_READY',
      platform: 'claude',
      conversationId: conversationId
    }).catch(() => {
      // Popup might not be open, ignore error
    });
  });

  /**
   * Listen for messages from popup/background
   */
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Proper sender validation
    if (!sender || sender.id !== browser.runtime.id) {
      logWarn('Message from unauthorized sender', { senderId: sender?.id });
      return;
    }

    // Validate message structure
    if (!message || typeof message.type !== 'string') {
      logWarn('Invalid message structure');
      return;
    }

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      const conversations = Array.from(capturedConversations.entries()).map(([id, data]) => ({
        id,
        title: data.name || 'Untitled Conversation'
      }));

      sendResponse({
        success: true,
        conversations: conversations,
        conversationIds: conversations.map(c => c.id), // Keep for backward compatibility
        platform: 'claude'
      });
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'claude') {
      const conversationId = message.conversationId;
      const conversationData = capturedConversations.get(conversationId);

      if (!conversationData) {
        sendResponse({
          success: false,
          error: 'Conversation not found. Please wait for the page to load the conversation.'
        });
        return false;
      }

      // Forward to background for CSV generation
      browser.runtime.sendMessage({
        type: MESSAGE_TYPE,
        payload: conversationData,
        platform: 'claude'
      }).then(() => {
        sendResponse({ success: true });
      }).catch(error => {
        sendResponse({
          success: false,
          error: error.message
        });
      });

      return true; // Keep channel open for async response
    }

    return false;
  });

  logInfo('Content script loaded');

})();

