/**
 * ChatGPT Platform - Content Script
 * 
 * This script:
 * 1. Injects inject.js into the page context
 * 2. Listens for conversation data via window.postMessage
 * 3. Forwards the data to the background script for processing
 */

(function () {
  'use strict';

  const PLATFORM = 'ChatGPT';
  const MESSAGE_TYPE = 'CHATGPT_CONVERSATION_DATA';
  const SOURCE_ID = 'chatgpt-exporter-inject';

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
  let SECRET_KEY = null;
  MessageSecurity.generateSecretKey().then(key => {
    SECRET_KEY = key;
    injectSecretIntoPage();
  });

  /**
   * Redact sensitive information from log data
   */
  function redactSensitiveData(data) {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const redacted = Array.isArray(data) ? [...data] : { ...data };

    // Redact conversation IDs (show first 8 chars only)
    if (redacted.conversationId && typeof redacted.conversationId === 'string') {
      redacted.conversationId = redacted.conversationId.substring(0, 8) + '...';
    }
    if (redacted.conversation_id && typeof redacted.conversation_id === 'string') {
      redacted.conversation_id = redacted.conversation_id.substring(0, 8) + '...';
    }
    if (redacted.id && typeof redacted.id === 'string' && redacted.id.length > 16) {
      redacted.id = redacted.id.substring(0, 8) + '...';
    }

    return redacted;
  }

  /**
   * Log debug message (only in debug mode)
   */
  function logDebug(message, data = null) {
    if (!DEBUG_MODE) return;
    if (data) {
      console.log(`[${PLATFORM}] [DEBUG]`, message, redactSensitiveData(data));
    } else {
      console.log(`[${PLATFORM}] [DEBUG]`, message);
    }
  }

  /**
   * Log info message
   */
  function logInfo(message, data = null) {
    if (data) {
      console.log(`[${PLATFORM}]`, message, redactSensitiveData(data));
    } else {
      console.log(`[${PLATFORM}]`, message);
    }
  }

  /**
   * Log warning message
   */
  function logWarn(message, data = null) {
    if (data) {
      console.warn(`[${PLATFORM}] [WARN]`, message, redactSensitiveData(data));
    } else {
      console.warn(`[${PLATFORM}] [WARN]`, message);
    }
  }

  /**
   * Log error message
   */
  function logError(message, data = null) {
    if (data) {
      console.error(`[${PLATFORM}] [ERROR]`, message, redactSensitiveData(data));
    } else {
      console.error(`[${PLATFORM}] [ERROR]`, message);
    }
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
        console.log(`[${PLATFORM}] Memory limit reached. Evicted oldest conversation:`, oldestId);
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
   * Inject secret key into page for inject.js to use
   */
  function injectSecretIntoPage() {
    if (!SECRET_KEY) return;
    const secretElement = document.createElement('meta');
    secretElement.name = 'chatgpt-exporter-secret';
    secretElement.content = SECRET_KEY;
    secretElement.style.display = 'none';
    (document.head || document.documentElement).appendChild(secretElement);
  }

  // Inject secret as early as possible (will be called when key is ready)

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
      console.warn(`[${PLATFORM}] Message source mismatch:`, event.data.source);
      return;
    }

    // Verify signed message using shared module
    if (!SECRET_KEY) {
      logWarn('Secret key not ready yet');
      return;
    }

    const verification = await MessageSecurity.verifySignedMessage(
      event.data,
      MESSAGE_TYPE,
      SOURCE_ID,
      SECRET_KEY
    );

    if (!verification.isValid) {
      logWarn('Message verification failed', { error: verification.error });
      return;
    }

    logDebug('Message signature verified');

    const conversationData = event.data.payload;

    if (!conversationData) {
      logWarn('Received message with no payload');
      return;
    }

    if (!conversationData.mapping) {
      logWarn('Received conversation data without mapping');
      return;
    }

    // Extract conversation ID
    const conversationId = conversationData.conversation_id || conversationData.id || 'unknown';

    // Store in memory with memory management
    storeConversation(conversationId, conversationData);

    logDebug('Stored conversation data', {
      conversationId: conversationId,
      nodeCount: Object.keys(conversationData.mapping || {}).length,
      totalCaptured: capturedConversations.size
    });

    // AUTOMATIC DOWNLOAD DISABLED FOR POLICY COMPLIANCE
    // Data is stored in memory (capturedConversations) and waits for manual export via popup
    logDebug('Conversation data captured and stored in memory', { conversationId });

    // Notify popup that conversation data is ready (event-driven update)
    browser.runtime.sendMessage({
      type: 'CONVERSATION_READY',
      platform: 'chatgpt',
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
      console.warn(`[${PLATFORM}] Message from unauthorized sender:`, sender?.id);
      return;
    }

    // Validate message structure
    if (!message || typeof message.type !== 'string') {
      console.warn(`[${PLATFORM}] Invalid message structure:`, message);
      return;
    }

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      const conversations = Array.from(capturedConversations.entries()).map(([id, data]) => ({
        id,
        title: data.title || 'Untitled Conversation'
      }));

      sendResponse({
        success: true,
        conversations: conversations,
        conversationIds: conversations.map(c => c.id), // Keep for backward compatibility
        platform: 'chatgpt'
      });
      return false;
    }

    if (message.type === 'EXPORT_CONVERSATION' && message.platform === 'chatgpt') {
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
        platform: 'chatgpt'
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



