/**
 * Main Background Script - Platform Router
 *
 * Routes conversation data to platform-specific handlers
 * and manages CSV generation and downloads
 */

import { extractChatGPTConversation, generateMessageUrlsCSV, generateDonorContextCSV } from './platforms/chatgpt/extractor.js';
import { EXTENSION_CONFIG } from './config/settings.js';
import { escapeCSVField, generateCSV, createCSVBlob, generateFilename } from './utils/csv.js';




/**
 * Claude Platform Handler
 * Handles Claude-specific conversation data processing
 */
const ClaudeHandler = {
  /**
   * Extract text content from Claude message content array
   * Claude messages can have multiple content blocks
   */
  extractTextFromContent(content) {
    if (!content || !Array.isArray(content)) {
      return '';
    }

    return content
      .filter(block => block && block.type === 'text')
      .map(block => block.text || '')
      .join('\n\n');
  },

  /**
   * Flatten Claude conversation data into CSV rows
   */
  flattenConversationData(convJson) {
    if (!convJson || !Array.isArray(convJson.chat_messages)) {
      console.warn('[Claude] Invalid conversation data: missing chat_messages');
      return [];
    }

    const messages = convJson.chat_messages;
    const conversationId = convJson.uuid || '';
    const conversationName = convJson.name || '';
    const rows = [];

    for (const msg of messages) {
      try {
        // Extract text from content array
        const text = this.extractTextFromContent(msg.content);

        // Build row
        const row = {
          conversation_id: conversationId,
          conversation_name: conversationName,
          message_id: msg.uuid || '',
          parent_message_id: msg.parent_message_uuid || '',
          sender: msg.sender || '',
          text: text,
          created_at: msg.created_at || '',
          updated_at: msg.updated_at || '',
          index: msg.index !== undefined ? msg.index : '',
          truncated: msg.truncated || false,
          stop_reason: msg.stop_reason || ''
        };

        rows.push(row);
      } catch (error) {
        console.error('[Claude] Error processing message:', error);
        // Continue with next message
      }
    }

    return rows;
  }
};

/**
 * Copilot Platform Handler
 * Handles Copilot-specific conversation data processing
 */
const CopilotHandler = {
  /**
   * Extract text content from Copilot content parts array
   * Copilot messages can have multiple content parts with type "text"
   */
  extractTextFromContent(content) {
    if (!content || !Array.isArray(content)) {
      return '';
    }

    return content
      .filter(part => part && part.type === 'text')
      .map(part => part.text || '')
      .join('\n\n');
  },

  /**
   * Flatten Copilot conversation data into CSV rows
   */
  flattenConversationData(convJson) {
    if (!convJson || !Array.isArray(convJson.results)) {
      console.warn('[Copilot] Invalid conversation data: missing results');
      return [];
    }

    const results = convJson.results;
    const conversationId = convJson.conversationId || '';
    const rows = [];

    for (const result of results) {
      try {
        // Extract text from content array
        const text = this.extractTextFromContent(result.content);

        // Map author.type to role
        const authorType = result.author?.type || '';
        const role = authorType === 'human' ? 'user' :
          authorType === 'ai' ? 'assistant' :
            authorType;

        // Extract part IDs (for reference)
        const partIds = result.content
          ?.filter(part => part && part.type === 'text')
          .map(part => part.partId || '')
          .join(',') || '';

        // Build row
        const row = {
          conversation_id: conversationId,
          message_id: result.id || '',
          role: role,
          text: text,
          created_at: result.createdAt || '',
          channel: result.channel || '',
          mode: result.mode || '',
          part_ids: partIds,
          author_type: authorType
        };

        rows.push(row);
      } catch (error) {
        console.error('[Copilot] Error processing result:', error);
        // Continue with next result
      }
    }

    return rows;
  }
};


/**
 * Validate conversation data structure and size
 * @param {Object} data - The conversation data to validate
 * @param {string} platform - The platform identifier
 * @returns {Object} Validation result with isValid and error properties
 */
function validateConversationData(data, platform) {
  // Basic type check
  if (!data || typeof data !== 'object') {
    return { isValid: false, error: 'Data is not an object' };
  }

  // Size limit check (prevent DoS attacks)
  const MAX_PAYLOAD_SIZE = 50 * 1024 * 1024; // 50MB
  try {
    const jsonString = JSON.stringify(data);
    const jsonSize = jsonString.length;

    if (jsonSize > MAX_PAYLOAD_SIZE) {
      return {
        isValid: false,
        error: `Payload too large: ${(jsonSize / 1024 / 1024).toFixed(2)}MB (max: 50MB)`
      };
    }
  } catch (error) {
    return { isValid: false, error: 'Failed to serialize data: ' + error.message };
  }

  // Platform-specific structure validation
  switch (platform) {
    case 'chatgpt':
      // ChatGPT requires either mapping or conversation_id
      if (!data.mapping && !data.conversation_id) {
        return {
          isValid: false,
          error: 'ChatGPT data missing required fields (mapping or conversation_id)'
        };
      }
      // Validate mapping structure if present
      if (data.mapping && typeof data.mapping !== 'object') {
        return { isValid: false, error: 'ChatGPT mapping is not an object' };
      }
      break;

    case 'claude':
      // Claude requires chat_messages array
      if (!Array.isArray(data.chat_messages)) {
        return {
          isValid: false,
          error: 'Claude data missing required chat_messages array'
        };
      }
      // Validate array is not empty
      if (data.chat_messages.length === 0) {
        return { isValid: false, error: 'Claude chat_messages array is empty' };
      }
      break;

    case 'copilot':
      // Copilot requires results array
      if (!Array.isArray(data.results)) {
        return {
          isValid: false,
          error: 'Copilot data missing required results array'
        };
      }
      // Validate array is not empty
      if (data.results.length === 0) {
        return { isValid: false, error: 'Copilot results array is empty' };
      }
      break;

    default:
      // For unknown platforms, just ensure it's an object
      console.warn(`[${platform}] Unknown platform, skipping detailed validation`);
      break;
  }

  return { isValid: true, error: null };
}

/**
 * Get or create a persistent donor ID stored in local extension storage.
 * Returns { id, type } where type is "persistent" (storage worked) or
 * "session" (storage failed — ID is not stable across exports).
 */
async function getOrCreateDonorId() {
  try {
    const stored = await browser.storage.local.get('donor_id');
    if (stored.donor_id) return { id: stored.donor_id, type: 'persistent' };
    const id = crypto.randomUUID();
    await browser.storage.local.set({ donor_id: id });
    return { id, type: 'persistent' };
  } catch {
    return { id: crypto.randomUUID(), type: 'session' };
  }
}

/**
 * Handle conversation data from any platform
 */
async function handleConversationData(message) {
  const platform = message.platform || 'unknown';
  const conversationData = message.payload;

  if (!conversationData) {
    console.error(`[${platform}] No conversation data in message`);
    return;
  }

  // Validate conversation data
  const validation = validateConversationData(conversationData, platform);
  if (!validation.isValid) {
    console.error(`[${platform}] Invalid conversation data:`, validation.error);
    return;
  }

  console.log(`[${platform}] Processing conversation data (validated)`);

  try {
    const { id: donorId, type: donorIdType } = await getOrCreateDonorId();
    const downloadTime = new Date().toISOString();

    // Get platform-specific handler
    let rows;
    let csvFiles = []; // Array of { filename, content }

    if (platform === 'chatgpt') {
      // Use the new extractor which returns multiple CSVs
      if (typeof extractChatGPTConversation === 'function') {
        const result = extractChatGPTConversation(conversationData, { donorId, donorIdType, downloadTime });

        const conversationId = conversationData.conversation_id || conversationData.id || 'unknown';
        const idShort = conversationId.substring(0, 8);

        csvFiles.push({
          filename: generateFilename(`chatgpt_metadata`, idShort),
          content: result.metadataCSV
        });

        csvFiles.push({
          filename: generateFilename(`chatgpt_messages`, idShort),
          content: result.messagesCSV
        });

        if (result.searchResults && result.searchResults.length > 0) {
          csvFiles.push({
            filename: generateFilename(`chatgpt_sources`, idShort),
            content: result.sourcesCSV
          });
        }

        if (result.messageUrls && result.messageUrls.length > 0) {
          csvFiles.push({
            filename: generateFilename(`chatgpt_message_urls`, idShort),
            content: result.messageUrlsCSV
          });
        }

        if (result.donorContext &&
            (result.donorContext.user_profile || result.donorContext.user_instructions)) {
          csvFiles.push({
            filename: generateFilename(`chatgpt_donor_context`, idShort),
            content: result.donorContextCSV
          });
        }
      } else {
        console.error('[ChatGPT] Extractor function not found');
        return;
      }
    } else if (platform === 'claude' && ClaudeHandler) {
      rows = ClaudeHandler.flattenConversationData(conversationData).map(row => ({
        donor_id: donorId,
        donor_id_type: donorIdType,
        download_time: downloadTime,
        ...row
      }));
    } else if (platform === 'copilot' && CopilotHandler) {
      rows = CopilotHandler.flattenConversationData(conversationData).map(row => ({
        donor_id: donorId,
        donor_id_type: donorIdType,
        download_time: downloadTime,
        ...row
      }));
    } else {
      console.error(`[${platform}] No handler found for platform`);
      return;
    }

    // If we have rows (legacy single CSV path), convert to csvFiles format
    if (rows && rows.length > 0) {
      const csv = generateCSV(rows);
      const conversationId = conversationData.conversation_id || conversationData.id || 'unknown';
      const idShort = conversationId.substring(0, 8);
      const filename = generateFilename(`${platform}_conversation`, idShort);

      csvFiles.push({
        filename: filename,
        content: csv
      });
    } else if (csvFiles.length === 0) {
      console.warn(`[${platform}] No data extracted from conversation`);
      return;
    }

    // Process all CSV files
    csvFiles.forEach((file, index) => {
      // Create blob with UTF-8 BOM
      const blob = createCSVBlob(file.content);
      const url = URL.createObjectURL(blob);

      // Trigger download with a small delay between files to ensure browser handles them
      setTimeout(() => {
        browser.downloads.download({
          url: url,
          filename: file.filename,
          saveAs: false
        }).then(() => {
          console.log(`[${platform}] ✓ Download triggered`, {
            filename: file.filename
          });

          setTimeout(() => {
            URL.revokeObjectURL(url);
          }, 1000);
        }).catch(error => {
          console.error(`[${platform}] ✗ Download failed:`, error);
          URL.revokeObjectURL(url);
        });
      }, index * 500);
    });

  } catch (error) {
    console.error(`[${platform}] Error processing conversation data:`, error);
  }
}

/**
 * Message listener - routes to platform handlers
 */
browser.runtime.onMessage.addListener((message, sender) => {
  // Proper sender validation
  if (!sender || sender.id !== browser.runtime.id) {
    console.warn('[Background] Message from unauthorized sender:', sender?.id);
    return;
  }

  // For content scripts, validate the URL matches expected domains
  if (sender.tab) {
    try {
      const url = new URL(sender.tab.url);
      const allowedDomains = Object.values(EXTENSION_CONFIG.platforms)
        .filter(platform => platform.enabled)
        .reduce((acc, platform) => acc.concat(platform.domains || []), []);

      if (!allowedDomains.some(domain => url.hostname.endsWith(domain))) {
        console.warn('[Background] Message from unauthorized domain:', url.hostname);
        return;
      }
    } catch (error) {
      console.warn('[Background] Invalid URL in sender tab:', error);
      return;
    }
  }

  // Validate message structure
  if (!message || typeof message.type !== 'string') {
    console.warn('[Background] Invalid message structure:', message);
    return;
  }

  // Handle ChatGPT conversation data
  if (message.type === 'CHATGPT_CONVERSATION_DATA') {
    handleConversationData({
      platform: message.platform || 'chatgpt',
      payload: message.payload
    });
    return false;
  }

  // Handle Claude conversation data
  if (message.type === 'CLAUDE_CONVERSATION_DATA') {
    handleConversationData({
      platform: message.platform || 'claude',
      payload: message.payload
    });
    return false;
  }

  // Handle Copilot conversation data
  if (message.type === 'COPILOT_CONVERSATION_DATA') {
    handleConversationData({
      platform: message.platform || 'copilot',
      payload: message.payload
    });
    return false;
  }

  // Add other platform message types here as they're implemented


  return false;
});

console.log('AI Chat Exporter: Main background script loaded at ' + new Date().toISOString());

// Runtime Integrity Monitoring
// Register critical functions for integrity checking
const criticalFunctions = {
  validateConversationData,
  escapeCSVField,
  extractChatGPTConversation,
  generateMessageUrlsCSV,
  generateDonorContextCSV
};

// Simple function fingerprinting for runtime integrity
const functionFingerprints = new Map();

function registerCriticalFunctions() {
  for (const [name, func] of Object.entries(criticalFunctions)) {
    if (typeof func === 'function') {
      const source = func.toString();
      let hash = 0;
      for (let i = 0; i < source.length; i++) {
        hash = ((hash << 5) - hash) + source.charCodeAt(i);
        hash = hash & hash;
      }
      functionFingerprints.set(name, hash);
    }
  }
  console.log('[Integrity] Registered', functionFingerprints.size, 'critical functions');
}

function verifyIntegrity() {
  let tamperedCount = 0;

  for (const [name, expectedHash] of functionFingerprints.entries()) {
    const func = criticalFunctions[name];
    if (!func) {
      console.error('[Integrity] Critical function missing:', name);
      tamperedCount++;
      continue;
    }

    const source = func.toString();
    let actualHash = 0;
    for (let i = 0; i < source.length; i++) {
      actualHash = ((actualHash << 5) - actualHash) + source.charCodeAt(i);
      actualHash = actualHash & actualHash;
    }

    if (actualHash !== expectedHash) {
      console.error('[Integrity] Function tampering detected:', name);
      tamperedCount++;
    }
  }

  if (tamperedCount === 0) {
    console.log('[Integrity] All critical functions verified');
  } else {
    console.error('[Integrity] Tampering detected in', tamperedCount, 'function(s)');
  }

  return tamperedCount === 0;
}

// Initialize integrity checking
registerCriticalFunctions();

// Verify integrity periodically (every 5 minutes)
setInterval(() => {
  verifyIntegrity();
}, 300000);

// Verify on first load
setTimeout(() => {
  verifyIntegrity();
}, 1000);

// Global error handler
self.addEventListener('unhandledrejection', event => {
  console.error('[Background] Unhandled rejection:', event.reason);
});
