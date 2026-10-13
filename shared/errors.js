// Shared error taxonomy and sanitization helpers for AI Chat Exporter
// Used by popup UI and can be reused by background/content scripts.

/**
 * Error types and their corresponding user-friendly messages.
 * These are UI-agnostic and describe the "error model".
 */
const ERROR_TYPES = {
  NO_ACTIVE_TAB: {
    message: 'Unable to access current tab',
    detail: 'Please try closing and reopening the popup.',
    troubleshooting: 'If the issue persists, try reloading the page or restarting your browser.'
  },
  UNSUPPORTED_PLATFORM: {
    message: 'This page is not supported',
    detail: 'Please navigate to a supported chat platform.',
    troubleshooting: 'Supported platforms: ChatGPT, Claude, Copilot, DeepSeek, Grok, Perplexity, and Google AI Overview.'
  },
  NO_CONVERSATION_ID: {
    message: 'No conversation detected',
    detail: 'Please open or start a conversation to export.',
    troubleshooting: null // Platform-specific, set dynamically
  },
  CONTENT_SCRIPT_NOT_LOADED: {
    message: 'Extension not ready',
    detail: 'The page may still be loading.',
    troubleshooting: 'Try refreshing the page and waiting a few seconds before exporting.'
  },
  NO_DATA_AVAILABLE: {
    message: 'No conversation data found',
    detail: 'The conversation may be empty or not yet loaded.',
    troubleshooting: null // Platform-specific, set dynamically
  },
  EXPORT_FAILED: {
    message: 'Export failed',
    detail: 'An error occurred during export.',
    troubleshooting: null // Platform-specific, set dynamically
  },
  PERMISSION_DENIED: {
    message: 'Permission denied',
    detail: 'Unable to access the page content.',
    troubleshooting: 'Please check that the extension has permission to access this site in your browser settings.'
  },
  NETWORK_ERROR: {
    message: 'Network error',
    detail: 'Unable to communicate with the page.',
    troubleshooting: 'Check your internet connection and try refreshing the page.'
  },
  UNKNOWN_ERROR: {
    message: 'An unexpected error occurred',
    detail: 'Please try again.',
    troubleshooting: 'If the problem continues, try reloading the page or restarting your browser.'
  },
  AUTH_FAILED: {
    // Platform name is interpolated at display time; detail/troubleshooting
    // come from PLATFORM_TROUBLESHOOTING[platform].authFailed below.
    message: 'Please sign in to continue.',
    detail: null,
    troubleshooting: null
  }
};

/**
 * Build a user-facing sign-in message for an auth failure. Takes the
 * platform id, returns {message, detail}. The platform display name is
 * resolved from EXTENSION_CONFIG at the call site so this module stays
 * side-effect-free; here we just template the per-platform copy.
 *
 * @param {string} platformDisplayName — "Claude", "ChatGPT", etc.
 * @returns {{message: string, detail: string}}
 */
function formatAuthFailureCopy(platformDisplayName) {
  return {
    message: `Please sign in to ${platformDisplayName} to continue.`,
    detail: `The last request got a 401 — your session on ${platformDisplayName} looks signed out. Sign in on the ${platformDisplayName} tab, then reopen this popup.`
  };
}

/**
 * Platform-specific troubleshooting tips.
 * These are also UI-agnostic and can be surfaced anywhere.
 */
const PLATFORM_TROUBLESHOOTING = {
  chatgpt: {
    noConversationId: 'Make sure you are on a conversation page (URL should contain /c/).',
    noData: 'Try scrolling through the conversation to ensure all messages are loaded.',
    exportFailed: 'Try refreshing the page and waiting for the conversation to fully load before exporting.'
  },
  claude: {
    noData: 'Start a conversation first, then try exporting. Data is captured as you chat.',
    exportFailed: 'Make sure you have sent at least one message in the conversation before exporting.',
    authFailed: 'Sign in on your claude.ai tab, then reopen this popup.'
  },
  copilot: {
    noConversationId: 'Make sure you are on a conversation page (URL should contain /chats/).',
    noData: 'Try scrolling through the conversation to ensure all messages are loaded.',
    exportFailed: 'Try refreshing the page and waiting for the conversation to fully load before exporting.'
  },
  grok: {
    noConversationId: 'Make sure you are on a conversation page (URL should contain /c/).',
    noData: 'Reload the page so Grok re-fetches the conversation, then try exporting again.',
    exportFailed: 'Reload the page and wait for the conversation to fully render before exporting.'
  },
  deepseek: {
    noConversationId: 'Make sure you are on a conversation page (URL should contain /a/chat/s/).',
    noData: 'Reload the page so DeepSeek re-fetches the conversation, then try exporting again.',
    exportFailed: 'Reload the page and wait for the conversation to fully render before exporting.'
  }
};

/**
 * Sanitize error message to prevent exposure of sensitive data.
 * Removes UUIDs, emails, file paths, URLs, tokens, organization IDs, etc.
 * This is safe to use in any context (popup, background, content scripts).
 * @param {string} message - Raw error message
 * @returns {string} Sanitized error message
 */
function sanitizeErrorMessage(message) {
  if (!message) return 'An error occurred';

  // Ensure message is a string
  let sanitized = String(message);

  // Remove UUIDs (conversation IDs, session IDs, etc.)
  sanitized = sanitized.replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '[id]');

  // Remove email addresses
  sanitized = sanitized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[email]');

  // Remove Windows file paths (e.g., C:\Users\username\file.txt)
  sanitized = sanitized.replace(/[A-Za-z]:\\[\w\\\-. ]+/g, '[path]');

  // Remove Unix/Mac file paths (e.g., /home/username/file.txt)
  // Be conservative to avoid removing legitimate text like "and/or"
  sanitized = sanitized.replace(/\/(?:home|users|usr|var|opt|etc)[\w\/\-. ]*/gi, '[path]');
  sanitized = sanitized.replace(/\/[\w\-]+\/[\w\-]+\/[\w\/\-. ]{10,}/g, '[path]');

  // Remove URLs (must be done before token removal to avoid partial matches)
  sanitized = sanitized.replace(/https?:\/\/[^\s]+/g, '[url]');

  // Remove organization IDs (e.g., org-abc123, org_abc123)
  sanitized = sanitized.replace(/org[-_][a-zA-Z0-9]+/gi, '[org-id]');

  // Remove project IDs (e.g., proj-abc123, project-abc123)
  sanitized = sanitized.replace(/proj(?:ect)?[-_][a-zA-Z0-9]+/gi, '[project-id]');

  // Remove API keys and tokens (more conservative - only long alphanumeric strings)
  // Use word boundaries to avoid removing legitimate words
  sanitized = sanitized.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]');

  // Remove potential session tokens or JWT tokens
  sanitized = sanitized.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt]');

  // Remove IP addresses
  sanitized = sanitized.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');

  // Remove port numbers in URLs or addresses
  sanitized = sanitized.replace(/:\d{2,5}\b/g, ':[port]');

  // Truncate very long messages
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 197) + '...';
  }

  return sanitized;
}

// Expose on the global object for use in different execution contexts.
// - In extension pages (popup), this runs as a classic script, so ERROR_TYPES,
//   PLATFORM_TROUBLESHOOTING and sanitizeErrorMessage are available as globals.
// - In the background service worker (module), this file can be imported for
//   its side effects and will attach the same objects to the global scope.
(function exposeErrorsToGlobal(globalObj) {
  if (!globalObj) return;
  globalObj.ERROR_TYPES = ERROR_TYPES;
  globalObj.PLATFORM_TROUBLESHOOTING = PLATFORM_TROUBLESHOOTING;
  globalObj.sanitizeErrorMessage = sanitizeErrorMessage;
  globalObj.formatAuthFailureCopy = formatAuthFailureCopy;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null)));
