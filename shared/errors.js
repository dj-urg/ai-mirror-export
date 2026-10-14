// Shared error taxonomy and sanitization helpers for AI Chat Exporter.
// ES module: imported by popup.js and background.js.

/**
 * Error types and their corresponding user-friendly messages.
 * These are UI-agnostic and describe the "error model".
 */
export const ERROR_TYPES = {
  NO_ACTIVE_TAB: {
    message: 'Unable to access current tab',
    detail: 'Please try closing and reopening the popup.',
    troubleshooting: 'If the issue persists, try reloading the page or restarting your browser.'
  },
  UNSUPPORTED_PLATFORM: {
    message: "The extension doesn't support this page.",
    detail: 'Open one of the supported sites below and come back.',
    troubleshooting: 'Supported sites: ChatGPT, Claude, Copilot, Microsoft 365 Copilot, Perplexity, Grok, DeepSeek, Mistral, and Google AI Overview.'
  },
  NO_CONVERSATION_ID: {
    message: "This page doesn't look like a conversation yet.",
    detail: 'Open an existing chat or start a new one, then try again.',
    troubleshooting: null // Platform-specific, set dynamically
  },
  CONTENT_SCRIPT_NOT_LOADED: {
    message: 'Extension not ready',
    detail: 'The page may still be loading.',
    troubleshooting: 'Try refreshing the page and waiting a few seconds before exporting.'
  },
  NO_DATA_AVAILABLE: {
    message: "The extension hasn't captured this conversation yet.",
    detail: 'Scroll through the conversation so every message loads, then reopen this popup.',
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
export function formatAuthFailureCopy(platformDisplayName) {
  return {
    message: `Please sign in to ${platformDisplayName} to continue.`,
    detail: `It looks like you are signed out of ${platformDisplayName}. Sign in on the ${platformDisplayName} tab, then reopen this popup.`
  };
}

/**
 * Platform-specific troubleshooting tips.
 * These are also UI-agnostic and can be surfaced anywhere.
 */
export const PLATFORM_TROUBLESHOOTING = {
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
  },
  mistral: {
    noConversationId: 'Make sure you are on a conversation page (URL should contain /chat/ or /work/).',
    noData: 'Reload the page so Mistral re-fetches the conversation, then try exporting again.',
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
export function sanitizeErrorMessage(message) {
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

