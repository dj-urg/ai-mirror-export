/**
 * Shared Logging Utility (ES module, used by popup.js)
 *
 * Provides centralized logging with:
 * - Debug flag control
 * - Sensitive data redaction
 * - Consistent formatting
 *
 * Content and inject scripts carry their own copy because they run as
 * classic scripts in page contexts that cannot import modules.
 */

// Configuration
const IS_PRODUCTION = true; // Set to false to enable all console output during development
const DEBUG_MODE = false;   // Set to true (with IS_PRODUCTION=false) for verbose debug logs

/**
 * Redact sensitive information from data
 * @param {any} data - Data to redact
 * @returns {any} Redacted data
 */
function redactSensitiveData(data) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  // Error properties (message, name, stack) are non-enumerable and lost in spread.
  // Convert to a plain object; drop stack to avoid leaking internal file paths.
  if (data instanceof Error) {
    return { name: data.name, message: data.message };
  }

  // Create shallow copy to avoid mutating original
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
  if (redacted.uuid && typeof redacted.uuid === 'string') {
    redacted.uuid = redacted.uuid.substring(0, 8) + '...';
  }

  // Redact user information
  if (redacted.email) {
    redacted.email = '[redacted]';
  }
  if (redacted.username) {
    redacted.username = '[redacted]';
  }
  if (redacted.userId) {
    redacted.userId = '[redacted]';
  }

  // Redact authentication tokens
  if (redacted.token) {
    redacted.token = '[redacted]';
  }
  if (redacted.accessToken) {
    redacted.accessToken = '[redacted]';
  }
  if (redacted.Authorization) {
    redacted.Authorization = '[redacted]';
  }

  // Redact message content (keep count only)
  if (redacted.messages && Array.isArray(redacted.messages)) {
    redacted.messages = `[${redacted.messages.length} messages]`;
  }
  if (redacted.chat_messages && Array.isArray(redacted.chat_messages)) {
    redacted.chat_messages = `[${redacted.chat_messages.length} messages]`;
  }
  if (redacted.results && Array.isArray(redacted.results)) {
    redacted.results = `[${redacted.results.length} results]`;
  }

  // Redact conversation titles (may contain sensitive info)
  if (redacted.title && typeof redacted.title === 'string') {
    redacted.title = '[redacted]';
  }
  if (redacted.name && typeof redacted.name === 'string') {
    redacted.name = '[redacted]';
  }

  return redacted;
}

/**
 * Log debug message (only in debug mode)
 * @param {string} platform - Platform name
 * @param {string} message - Log message
 * @param {any} data - Optional data to log
 */
export function logDebug(platform, message, data = null) {
  if (IS_PRODUCTION || !DEBUG_MODE) return;

  if (data) {
    const redacted = redactSensitiveData(data);
    console.log(`[${platform}] [DEBUG]`, message, redacted);
  } else {
    console.log(`[${platform}] [DEBUG]`, message);
  }
}

/**
 * Log error message (always shown)
 * @param {string} platform - Platform name
 * @param {string} message - Log message
 * @param {any} data - Optional data to log
 */
export function logError(platform, message, data = null) {
  if (IS_PRODUCTION) return;
  if (data) {
    const redacted = redactSensitiveData(data);
    console.error(`[${platform}] [ERROR]`, message, redacted);
  } else {
    console.error(`[${platform}] [ERROR]`, message);
  }
}

