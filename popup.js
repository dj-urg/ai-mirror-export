/**
 * popup.js - Popup UI Logic
 *
 * Multi-platform UI that:
 * 1. Detects which platform the user is on
 * 2. Shows status of captured conversations
 * 3. Triggers export when user clicks button
 */

// ============================================================================
// PRODUCTION FLAG
// ============================================================================

// In production, suppress all console output to avoid leaking operational
// details and internal state to the browser console.
const IS_PRODUCTION = true;
const _console = IS_PRODUCTION ? { log: () => {}, warn: () => {}, error: () => {} } : console;

// ============================================================================
// PLATFORM CONFIGURATION (UI-specific; core config in config/settings.js)
// ============================================================================

const PLATFORMS = {
  chatgpt: {
    name: 'ChatGPT',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" fill="currentColor"/></svg>',
    requiresConversationId: true,
    extractConversationId: (url) => {
      const match = url.match(/\/c\/([a-f0-9-]+)/i);
      return match ? match[1] : null;
    }
  },
  claude: {
    name: 'Claude',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M17.5 3.5L14 10l3.5 6.5L21 10l-3.5-6.5z" fill="currentColor"/><path d="M10 3.5L6.5 10 10 16.5 13.5 10 10 3.5z" fill="currentColor"/><path d="M6.5 10L3 16.5 6.5 23 10 16.5 6.5 10z" fill="currentColor"/></svg>',
    requiresConversationId: true,
    extractConversationId: (url) => {
      const match = url.match(/\/chat\/([a-f0-9-]+)/i);
      return match ? match[1] : null;
    }
  },
  copilot: {
    name: 'Copilot',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" fill="currentColor"/><circle cx="8.5" cy="11" r="1.5" fill="currentColor"/><circle cx="15.5" cy="11" r="1.5" fill="currentColor"/><path d="M12 17c2.21 0 4-1.79 4-4h-8c0 2.21 1.79 4 4 4z" fill="currentColor"/></svg>',
    requiresConversationId: true,
    extractConversationId: (url) => {
      const match = url.match(/\/chats\/([a-zA-Z0-9_-]+)/i);
      return match ? match[1] : null;
    }
  },
  m365_copilot: {
    name: 'M365 Copilot',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" fill="currentColor"/><circle cx="8.5" cy="11" r="1.5" fill="currentColor"/><circle cx="15.5" cy="11" r="1.5" fill="currentColor"/><path d="M12 17c2.21 0 4-1.79 4-4h-8c0 2.21 1.79 4 4 4z" fill="currentColor"/></svg>',
    // The conversation id lives in the Chathub WebSocket query string, not in
    // the page URL — inject.js reads it there. Treat the platform like Claude:
    // whichever conversation has been captured most recently is what we export.
    requiresConversationId: false,
    extractConversationId: () => null
  },

  perplexity: {
    name: 'Perplexity',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 7v10l10 5 10-5V7L12 2zm0 2.18L19.82 8 12 11.82 4.18 8 12 4.18zM4 9.73l7 3.5v7.54l-7-3.5V9.73zm9 11.04v-7.54l7-3.5v7.54l-7 3.5z" fill="currentColor"/></svg>',
    requiresConversationId: true,
    extractConversationId: (url) => {
      const match = url.match(/\/search\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return match ? match[1] : null;
    }
  },

  grok: {
    name: 'Grok',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h3l5 8-5 8H4l5-8-5-8zm9 0h3l5 8-5 8h-3l5-8-5-8z" fill="currentColor"/></svg>',
    requiresConversationId: true,
    extractConversationId: (url) => {
      const match = url.match(/\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return match ? match[1] : null;
    }
  },

  deepseek: {
    name: 'DeepSeek',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm5.5 11.5a1 1 0 01-1 1h-9a1 1 0 010-2h9a1 1 0 011 1zm0-4a1 1 0 01-1 1h-9a1 1 0 010-2h9a1 1 0 011 1z" fill="currentColor"/></svg>',
    requiresConversationId: true,
    // DeepSeek's SPA route is `/a/:agentId/s/:sessionId` — the agent id
    // defaults to `chat` but DeepSeek has other agents (e.g. search), so
    // match any slug for the agent segment.
    extractConversationId: (url) => {
      const match = url.match(/\/a\/[^/]+\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return match ? match[1] : null;
    }
  },

  mistral: {
    name: 'Mistral',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4h4v4H3V4zm0 6h4v4H3v-4zm0 6h4v4H3v-4zM10 4h4v4h-4V4zm0 6h4v4h-4v-4zm0 6h4v4h-4v-4zM17 4h4v4h-4V4zm0 6h4v4h-4v-4zm0 6h4v4h-4v-4z" fill="currentColor"/></svg>',
    requiresConversationId: true,
    // Mistral exposes two URL shapes for the same chatId:
    //   /chat/<uuid>  — regular chat
    //   /work/<uuid>  — the "Vibe" / work product surface
    extractConversationId: (url) => {
      const match = url.match(/\/(?:chat|work)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      return match ? match[1] : null;
    }
  },

  google_search: {
    name: 'Google AI Overview',
    icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L13.09 8.26L19 9L13.09 9.74L12 16L10.91 9.74L5 9L10.91 8.26L12 2Z" fill="currentColor"/><circle cx="12" cy="18" r="2" fill="currentColor"/></svg>',
    requiresConversationId: false,
    // The "conversation" is the current search query; we don't derive it from
    // URL path like other platforms. The content script picks it off ?q=... .
    // Key format is `${query}::${mode}` where mode is 'ai_mode' or
    // 'ai_overview'. We deliberately exclude the full URL because Google
    // rewrites it client-side after load (adds sei=, sclient=, etc.), which
    // used to make the popup's ID drift away from the content script's
    // stored key between captures.
    extractConversationId: (url) => {
      try {
        const u = new URL(url);
        if (u.pathname !== '/search') return null;
        const q = u.searchParams.get('q');
        if (!q || !q.trim()) return null;
        const mode = u.searchParams.get('udm') === '50' ? 'ai_mode' : 'ai_overview';
        return `${q.trim()}::${mode}`;
      } catch { return null; }
    }
  },

};

// ============================================================================
// SHARED MODULES
// ============================================================================

import { EXTENSION_CONFIG, getPlatformByUrl } from './config/settings.js';
import {
  ERROR_TYPES,
  PLATFORM_TROUBLESHOOTING,
  formatAuthFailureCopy,
  sanitizeErrorMessage
} from './shared/errors.js';
import { logDebug, logError } from './shared/logger.js';

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

const state = {
  // Current platform detection
  platform: {
    id: null,
    name: null,
    conversationId: null
  },

  // Status information
  status: {
    type: 'info', // 'success' | 'warning' | 'error' | 'loading' | 'info'
    message: '',
    detail: ''
  },

  // Export state
  export: {
    isExporting: false,
    canExport: false,
    lastError: null
  },

  // Current tab information
  currentTab: null,

  // Polling state
  polling: {
    intervalId: null,
    isPolling: false,
    lastUpdateTime: 0,
    debounceTimeout: null
  },

  // Capture wait state — tracks how long we've been waiting for a conversation
  capture: {
    waitingSince: null,   // timestamp when we first found no data for this ID
    waitingForId: null,   // which conversationId we're waiting for
    lastTurnCount: 0,     // highest turn count reported by content scripts
    tickerId: null        // interval id for the loading-phase ticker
  }
};

// Loading-phase ticker. Nothing starts it any more (the Google branch only
// ever stops it); kept until the dead-code sweep removes the capture ticker
// state as a whole.
function stopCaptureTicker() {
  if (!state.capture.tickerId) return;
  clearInterval(state.capture.tickerId);
  state.capture.tickerId = null;
}

// How long to show "loading" before switching to the "not captured" warning.
const CAPTURE_LOADING_TIMEOUT_MS = 15000;

/**
 * Produce the detail-line for a stuck/loading status card. Centralises the
 * two capture mechanisms the extension uses — "reload" (ChatGPT, Claude,
 * Copilot: tab needs a fresh page load) and "reopen" (Google: content
 * script keeps capturing in the background; popup reads state at open
 * time, so closing + reopening the popup is the only way to see it). One
 * consistent structure, with mechanism-specific wording and a visible
 * elapsed counter so the user knows the popup hasn't frozen.
 *
 * @param {Object} opts
 * @param {number} opts.elapsedMs
 * @param {number} opts.threshold  — ms before switching to the "stuck" variant
 * @param {'reload'|'reopen'} opts.mechanism
 * @param {string} [opts.platformName]
 * @param {boolean} [opts.stuck]   — true to use the past-threshold variant
 * @returns {string}
 */
function formatStuckDetail({ elapsedMs, threshold, mechanism, platformName, stuck = false }) {
  const secs = Math.max(0, Math.round(elapsedMs / 1000));
  const prefix = platformName ? `${platformName}: ` : '';
  if (!stuck) {
    // Pre-threshold loading phase. Only surface the counter once we've been
    // waiting a few seconds — showing "0s" or "1s" on first paint is noise.
    const sinceLine = secs >= 3 ? ` (${secs}s)` : '';
    return `${prefix}this usually takes a few seconds${sinceLine}.`;
  }
  const threshSecs = Math.round(threshold / 1000);
  if (mechanism === 'reopen') {
    return `${prefix}still no capture after ${threshSecs}s. The extension reads this page's state when the popup opens — close this popup, wait a second or two, then reopen it.`;
  }
  // 'reload' mechanism (default)
  return `${prefix}still no data after ${threshSecs}s. The extension only captures as the page loads. Reload the tab in your browser, then reopen this popup.`;
}

// ============================================================================
// RATE LIMITING CONFIGURATION
// ============================================================================

/**
 * Rate limiting for export operations to prevent resource exhaustion
 * and denial of service attacks
 */
const exportRateLimit = {
  // Timestamp of last export
  lastExport: 0,

  // Minimum interval between exports (milliseconds)
  minInterval: 2000, // 2 seconds

  // Maximum exports allowed per minute
  maxExportsPerMinute: 10,

  // Array of recent export timestamps (for per-minute tracking)
  recentExports: []
};

// ============================================================================
// PLATFORM DETECTION
// ============================================================================

/**
 * Detect platform from URL with scheme validation
 * Uses shared EXTENSION_CONFIG via getPlatformByUrl for domain matching.
 * @param {string} url - The URL to check
 * @returns {Object|null} Platform object with id and config, or null if not supported
 */
function detectPlatform(url) {
  try {
    const parsedUrl = new URL(url);

    // Security: Only allow http and https schemes
    // Prevents exploitation via javascript:, data:, file:, chrome:, etc.
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      _console.warn('[Security] Invalid URL scheme detected:', parsedUrl.protocol, 'for URL:', url);
      return null;
    }

    const hostname = parsedUrl.hostname;

    // Validate hostname is not empty
    if (!hostname || hostname.trim() === '') {
      _console.warn('[Security] Empty hostname detected in URL:', url);
      return null;
    }

    const basePlatform = getPlatformByUrl(url);
    if (!basePlatform) {
      return null;
    }

    const uiConfig = PLATFORMS[basePlatform.id] || {};

    return {
      ...basePlatform,
      ...uiConfig,
      id: basePlatform.id,
      name: uiConfig.name || basePlatform.name
    };
  } catch (error) {
    _console.error('Error parsing URL:', error);
    return null;
  }
}

/**
 * Check if platform requires and has a conversation ID
 * @param {Object} platform - Platform object
 * @param {string} url - Current URL
 * @returns {Object} Object with hasConversationId and conversationId properties
 */
function checkConversationId(platform, url) {
  if (!platform) {
    return { hasConversationId: false, conversationId: null };
  }

  // Always attempt to extract an id when the platform defines one, even when
  // requiresConversationId is false — some platforms (e.g. Google AI Overview)
  // need the id to show the right popup state but don't block export without
  // it being present in the URL at popup-open time.
  const conversationId = typeof platform.extractConversationId === 'function'
    ? platform.extractConversationId(url)
    : null;

  if (!platform.requiresConversationId) {
    return { hasConversationId: true, conversationId };
  }

  return {
    hasConversationId: conversationId !== null,
    conversationId
  };
}

// ============================================================================
// ERROR HANDLING UTILITIES
// ============================================================================

/**
 * Log detailed error information using shared logger with popup context.
 * @param {string} context - Context where error occurred
 * @param {Error|string} error - Error object or message
 * @param {Object} additionalInfo - Additional debugging information
 */
function popupLogError(context, error, additionalInfo = {}) {
  const timestamp = new Date().toISOString();
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : null;

  const logData = {
    ...additionalInfo,
    context,
    timestamp,
    state: {
      platform: state.platform,
      export: state.export,
      status: state.status
    }
  };

  if (errorStack) {
    logData.errorStack = errorStack;
  }

  logError('popup', errorMessage, logData);
}

/**
 * Log debug information using shared logger with popup context.
 * @param {string} context - Context of the log
 * @param {string} message - Log message
 * @param {Object} additionalInfo - Additional debugging information
 */
function popupLogDebug(context, message, additionalInfo = {}) {
  const timestamp = new Date().toISOString();

  const logData = {
    ...additionalInfo,
    context,
    timestamp,
    state: {
      platform: state.platform,
      export: state.export,
      status: state.status
    }
  };

  logDebug('popup', message, logData);
}

/**
 * Get platform-specific troubleshooting tip
 * @param {string} platformId - Platform identifier
 * @param {string} errorType - Type of error (noConversationId, noData, exportFailed)
 * @returns {string|null} Troubleshooting tip or null
 */
function getPlatformTroubleshooting(platformId, errorType) {
  if (!platformId || !PLATFORM_TROUBLESHOOTING[platformId]) {
    return null;
  }

  return PLATFORM_TROUBLESHOOTING[platformId][errorType] || null;
}

/**
 * Display error with appropriate messaging and troubleshooting
 * @param {string} errorType - Error type from ERROR_TYPES
 * @param {Object} options - Additional options
 * @param {string} options.platformId - Platform ID for platform-specific tips
 * @param {string} options.customDetail - Custom detail message
 * @param {string} options.customTroubleshooting - Custom troubleshooting tip
 * @param {Error|string} options.originalError - Original error for logging
 */
function displayError(errorType, options = {}) {
  const errorConfig = ERROR_TYPES[errorType] || ERROR_TYPES.UNKNOWN_ERROR;
  const { platformId, customDetail, customTroubleshooting, originalError } = options;

  // Log detailed error for debugging
  if (originalError) {
    popupLogError(errorType, originalError, {
      platformId,
      errorType,
      customDetail,
      customTroubleshooting
    });
  }

  // Determine detail message
  const detailMessage = customDetail || errorConfig.detail;

  // Determine troubleshooting tip
  let troubleshootingTip = customTroubleshooting || errorConfig.troubleshooting;

  // Get platform-specific troubleshooting if available
  if (platformId && !troubleshootingTip) {
    const errorTypeKey = errorType.toLowerCase().replace(/_/g, '');
    if (errorTypeKey.includes('conversation')) {
      troubleshootingTip = getPlatformTroubleshooting(platformId, 'noConversationId');
    } else if (errorTypeKey.includes('data')) {
      troubleshootingTip = getPlatformTroubleshooting(platformId, 'noData');
    } else if (errorTypeKey.includes('export') || errorTypeKey.includes('failed')) {
      troubleshootingTip = getPlatformTroubleshooting(platformId, 'exportFailed');
    }
  }

  // Combine detail and troubleshooting
  let fullDetail = detailMessage;
  if (troubleshootingTip) {
    fullDetail = `${detailMessage} ${troubleshootingTip}`;
  }

  // Update UI with error
  updateStatus('error', errorConfig.message, fullDetail);

  // Store error in state for potential retry logic
  state.export.lastError = {
    type: errorType,
    message: errorConfig.message,
    detail: fullDetail,
    timestamp: Date.now()
  };

  // Ensure export button is enabled for retry (unless it's a permanent error)
  const permanentErrors = ['UNSUPPORTED_PLATFORM', 'PERMISSION_DENIED'];
  if (!permanentErrors.includes(errorType)) {
    // Re-enable button after a short delay to allow user to see error
    setTimeout(() => {
      if (!state.export.isExporting) {
        updateExportButton(true);
      }
    }, 500);
  } else {
    updateExportButton(false);
  }
}

// ============================================================================
// UI UPDATE FUNCTIONS
// ============================================================================

/**
 * Update platform badge in header
 * @param {Object|null} platform - Platform object or null to clear badge
 */
function updatePlatformBadge(platform) {
  const platformBadge = document.getElementById('platformBadge');

  if (!platform) {
    platformBadge.innerHTML = '';
    return;
  }

  // Use DOM methods instead of innerHTML to prevent XSS
  const badge = document.createElement('div');
  badge.className = `platform-badge platform-badge--${platform.id}`;

  const iconDiv = document.createElement('div');
  iconDiv.className = 'platform-badge__icon';
  iconDiv.setAttribute('aria-hidden', 'true');
  // Use DOMParser to safely parse SVG string instead of innerHTML
  const parser = new DOMParser();
  const doc = parser.parseFromString(platform.icon, 'image/svg+xml');
  const svgElement = doc.documentElement;

  // Import node to current document to ensure ownership
  const importedSvg = document.importNode(svgElement, true);
  iconDiv.appendChild(importedSvg);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'platform-badge__name';
  // Use textContent instead of innerHTML to prevent XSS
  nameSpan.textContent = platform.name;

  badge.appendChild(iconDiv);
  badge.appendChild(nameSpan);

  // Clear and append
  platformBadge.innerHTML = '';
  platformBadge.appendChild(badge);
}

/**
 * Update status card with message and type
 * @param {string} type - Status type: 'success' | 'warning' | 'error' | 'loading' | 'info'
 * @param {string} message - Main status message
 * @param {string} detail - Optional detail message (empty string or null to hide)
 */
function updateStatus(type, message, detail = '') {
  const statusCard = document.querySelector('.status-card');
  const statusMessage = document.getElementById('statusMessage');
  const statusDetail = document.getElementById('statusDetail');

  // Store current focus to maintain it during update
  const activeElement = document.activeElement;
  const activeElementId = activeElement?.id;

  // Validate status type
  const validTypes = ['success', 'warning', 'error', 'loading', 'info'];
  if (!validTypes.includes(type)) {
    _console.error(`Invalid status type: ${type}. Using 'info' as fallback.`);
    type = 'info';
  }

  // Check if status has actually changed (efficient DOM updates)
  const hasChanged =
    state.status.type !== type ||
    state.status.message !== message ||
    state.status.detail !== (detail || '');

  // Skip update if nothing changed
  if (!hasChanged) {
    return;
  }

  // Update state
  state.status.type = type;
  state.status.message = message;
  state.status.detail = detail || '';

  // Update status card styling based on status type (only if changed)
  const expectedClass = `status-card--${type}`;
  if (!statusCard.classList.contains(expectedClass)) {
    // Remove all status modifier classes first
    statusCard.className = 'status-card';
    // Add the new status modifier class
    statusCard.classList.add(expectedClass);
  }

  // Update status message text (only if changed)
  if (statusMessage.textContent !== message) {
    statusMessage.textContent = message;
  }

  // Update status detail text (only if changed)
  const newDetail = detail || '';
  if (statusDetail.textContent !== newDetail) {
    statusDetail.textContent = newDetail;
  }

  // Ensure ARIA live region announcements work properly
  // aria-atomic="true" ensures the entire status card content is announced
  statusCard.setAttribute('aria-atomic', 'true');

  // Set aria-live to "polite" for non-critical updates, "assertive" for errors
  // This ensures screen readers announce status changes appropriately
  if (type === 'error') {
    statusCard.setAttribute('aria-live', 'assertive');
  } else {
    statusCard.setAttribute('aria-live', 'polite');
  }

  // Restore focus if it was on an interactive element
  if (activeElementId && activeElement && activeElement.tagName !== 'BODY') {
    requestAnimationFrame(() => {
      const element = document.getElementById(activeElementId);
      if (element && document.activeElement === document.body) {
        element.focus();
      }
    });
  }

  // Log status update for debugging
  _console.log(`Status updated: [${type}] ${message}${detail ? ' - ' + detail : ''}`);
}

/**
 * Update export button state
 * @param {boolean} enabled - Whether the button should be enabled
 * @param {string} text - Optional button text override
 * @param {boolean} showSpinner - Whether to show loading spinner in button
 */
function updateExportButton(enabled, text = null, showSpinner = false) {
  const exportBtn = document.getElementById('exportBtn');
  const buttonText = exportBtn.querySelector('.btn__text');
  const buttonIcon = exportBtn.querySelector('.btn__icon');

  // Store focus state before update
  const wasFocused = document.activeElement === exportBtn;

  // Check if button state has actually changed (efficient DOM updates)
  const hasStateChanged = state.export.canExport !== enabled;
  const currentText = buttonText ? buttonText.textContent : '';
  const targetText = text || 'Export ZIP';
  const hasTextChanged = currentText !== targetText;
  const hasSpinnerChanged = buttonIcon.classList.contains('spinner') !== showSpinner;

  // Update state
  state.export.canExport = enabled;

  // Keep polling running at all times so the popup can detect in-place tab
  // reloads (user hits Cmd+R while the popup is open). Previously we stopped
  // polling once the export button became enabled, which left the popup
  // stuck on "Ready" even after the underlying page had been reloaded.
  // (Polling runs at 2s intervals; cost is negligible while the popup is up.)

  // Update DOM only if changed
  if (hasStateChanged) {
    exportBtn.disabled = !enabled;
  }

  // Update button text only if changed
  if (hasTextChanged && buttonText) {
    buttonText.textContent = targetText;
  }

  // Show/hide spinner in button only if changed
  if (hasSpinnerChanged) {
    if (showSpinner) {
      // Replace download icon with spinner using DOM methods
      buttonIcon.innerHTML = ''; // Clear existing content

      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'spinner__svg');
      svg.setAttribute('viewBox', '0 0 24 24');

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('class', 'spinner__circle');
      circle.setAttribute('cx', '12');
      circle.setAttribute('cy', '12');
      circle.setAttribute('r', '10');

      svg.appendChild(circle);
      buttonIcon.appendChild(svg);
      buttonIcon.classList.add('spinner');
    } else {
      // Restore download icon using DOM methods
      buttonIcon.innerHTML = ''; // Clear existing content

      const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path1.setAttribute('d', 'M8.75 1a.75.75 0 00-1.5 0v6.69L5.03 5.47a.75.75 0 00-1.06 1.06l3.5 3.5a.75.75 0 001.06 0l3.5-3.5a.75.75 0 10-1.06-1.06L8.75 7.69V1z');
      path1.setAttribute('fill', 'currentColor');

      const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path2.setAttribute('d', 'M3.5 9.75a.75.75 0 00-1.5 0v1.5A2.75 2.75 0 004.75 14h6.5A2.75 2.75 0 0014 11.25v-1.5a.75.75 0 00-1.5 0v1.5c0 .69-.56 1.25-1.25 1.25h-6.5c-.69 0-1.25-.56-1.25-1.25v-1.5z');
      path2.setAttribute('fill', 'currentColor');

      buttonIcon.appendChild(path1);
      buttonIcon.appendChild(path2);
      buttonIcon.classList.remove('spinner');
    }
  }

  // Restore focus if button was focused before update
  if (wasFocused && !exportBtn.disabled) {
    requestAnimationFrame(() => {
      exportBtn.focus();
    });
  }
}

/**
 * Build and show the file list panel.
 * Renders one row per platform (3 for ChatGPT, 1 for others).
 * @param {string} title - Conversation title (used for non-ChatGPT label)
 */
function updateFilePreview(title) {
  const fileList = document.getElementById('fileList');
  const fileListHeading = document.getElementById('fileListHeading');
  const fileListItems = document.getElementById('fileListItems');

  const platformId = state.platform.id;
  const platformName = state.platform.name || platformId || 'conversation';

  let files;
  if (platformId === 'chatgpt') {
    files = [
      {
        badge: 'Metadata',
        badgeClass: 'metadata',
        name: 'Conversation overview',
        desc: 'Title, model, statistics'
      },
      {
        badge: 'Messages',
        badgeClass: 'messages',
        name: 'Full message log',
        desc: 'All turns with timestamps and model info'
      },
      {
        badge: 'Sources',
        badgeClass: 'sources',
        name: 'Web search results',
        desc: 'Cited sources \u2014 only if web searches were made',
        optional: true
      },
      {
        badge: 'URLs',
        badgeClass: 'default',
        name: 'In-message links',
        desc: 'Links shared in messages \u2014 only if any were present',
        optional: true
      },
      {
        badge: 'Profile',
        badgeClass: 'metadata',
        name: 'User profile & instructions',
        desc: 'Custom instructions or user profile \u2014 only if configured',
        optional: true
      }
    ];
  } else if (platformId === 'perplexity') {
    files = [
      {
        badge: 'Metadata',
        badgeClass: 'metadata',
        name: 'Thread overview',
        desc: 'Title, timestamps, turn count'
      },
      {
        badge: 'Messages',
        badgeClass: 'messages',
        name: 'Full message log',
        desc: 'User prompts and assistant answers per turn'
      },
      {
        badge: 'Sources',
        badgeClass: 'sources',
        name: 'Cited web results',
        desc: 'Sources cited by Perplexity \u2014 only if present',
        optional: true
      }
    ];
  } else if (platformId === 'grok') {
    files = [
      {
        badge: 'Metadata',
        badgeClass: 'metadata',
        name: 'Conversation overview',
        desc: 'Title, timestamps, turn count'
      },
      {
        badge: 'Messages',
        badgeClass: 'messages',
        name: 'Full message log',
        desc: 'User prompts, assistant answers, timestamps'
      },
      {
        badge: 'Sources',
        badgeClass: 'sources',
        name: 'Cited web + X results',
        desc: 'Sources cited by Grok \u2014 only if present',
        optional: true
      }
    ];
  } else if (platformId === 'deepseek') {
    files = [
      {
        badge: 'Metadata',
        badgeClass: 'metadata',
        name: 'Conversation overview',
        desc: 'Title, model, turn count'
      },
      {
        badge: 'Messages',
        badgeClass: 'messages',
        name: 'Full message log',
        desc: 'User prompts, assistant answers, reasoning (if any)'
      },
      {
        badge: 'Sources',
        badgeClass: 'sources',
        name: 'Cited web results',
        desc: 'Sources cited by DeepSeek Search \u2014 only if present',
        optional: true
      }
    ];
  } else if (platformId === 'mistral') {
    files = [
      {
        badge: 'Metadata',
        badgeClass: 'metadata',
        name: 'Conversation overview',
        desc: 'Title, model, feature flags, turn count'
      },
      {
        badge: 'Messages',
        badgeClass: 'messages',
        name: 'Full message log',
        desc: 'User prompts, assistant answers, reasoning + tool calls'
      },
      {
        badge: 'Sources',
        badgeClass: 'sources',
        name: 'Cited web results',
        desc: 'Sources cited by Mistral \u2014 only if present',
        optional: true
      }
    ];
  } else {
    const sanitizedTitle = (title || 'conversation')
      .replace(/[^a-z0-9\u00a0-\uffff_-]/gi, '_').trim();
    files = [
      {
        badge: platformName,
        badgeClass: 'default',
        name: sanitizedTitle || 'conversation',
        desc: `${platformName} conversation export`
      }
    ];
  }

  fileListHeading.textContent = files.length === 1
    ? '1 file will be downloaded'
    : `${files.length} files will be downloaded`;

  // Rebuild the list using DOM methods (no innerHTML for security)
  while (fileListItems.firstChild) {
    fileListItems.removeChild(fileListItems.firstChild);
  }

  for (const file of files) {
    const li = document.createElement('li');
    li.className = 'file-list__item';

    const badge = document.createElement('span');
    badge.className = `file-list__badge file-list__badge--${file.badgeClass}`;
    badge.textContent = file.badge;

    const info = document.createElement('div');
    info.className = 'file-list__info';

    const name = document.createElement('span');
    name.className = 'file-list__name';
    name.textContent = file.name;

    const desc = document.createElement('span');
    desc.className = file.optional
      ? 'file-list__desc file-list__desc--optional'
      : 'file-list__desc';
    desc.textContent = file.desc;

    info.appendChild(name);
    info.appendChild(desc);
    li.appendChild(badge);
    li.appendChild(info);
    fileListItems.appendChild(li);
  }

  fileList.style.display = 'block';

  const dataNotice = document.getElementById('dataNotice');
  if (dataNotice) dataNotice.hidden = false;
}

/**
 * Hide the file list panel
 */
function hideFilePreview() {
  const fileList = document.getElementById('fileList');
  if (fileList) fileList.style.display = 'none';

  const dataNotice = document.getElementById('dataNotice');
  if (dataNotice) dataNotice.hidden = true;
}

/**
 * Show the Google-specific capture tip (close + reopen workflow).
 * Idempotent — safe to call every UI tick.
 */
function showGoogleTip() {
  const el = document.getElementById('googleTip');
  if (el) el.hidden = false;
}

/**
 * Hide the Google-specific capture tip.
 */
function hideGoogleTip() {
  const el = document.getElementById('googleTip');
  if (el) el.hidden = true;
}

// Reload prompt removed in the UX pass. Earlier builds exposed a
// "Reload Page" button in the popup that called browser.tabs.reload on
// the user's active tab. The audit flagged that reloading someone's
// tab from the popup is both surprising and bypasses browser
// affordances (confirm-on-reload, form state, scroll position). We now
// surface a message instead that asks the user to reload the tab
// themselves. hideReloadPrompt/showReloadPrompt/handleReloadClick +
// the #reloadBtn element are gone; see popup.html.

// ============================================================================
// EVENT-DRIVEN UPDATE MECHANISM (with fallback polling)
// ============================================================================

/**
 * Set up event-driven updates from content scripts
 * Content scripts notify popup when conversation data is captured
 */
function setupEventDrivenUpdates() {
  browser.runtime.onMessage.addListener((message, sender) => {
    // Validate sender is from our extension (shared check for all types below)
    if (!sender || sender.id !== browser.runtime.id) {
      _console.warn('[Popup] Ignoring privileged message from unauthorized sender');
      return;
    }

    // Background-initiated export outcome. Lets the popup surface a real
    // download/ZIP failure instead of a hung spinner, and clear the
    // "Exporting…" state when background's async pipeline actually finishes.
    if (message.type === 'EXPORT_RESULT') {
      handleExportResultMessage(message.detail || {});
      return;
    }

    // Content-script "fresh conversation data captured" notification.
    if (message.type !== 'CONVERSATION_READY') {
      return;
    }

    _console.log('[Popup] Conversation ready notification received', {
      platform: message.platform,
      conversationId: message.conversationId ? message.conversationId.substring(0, 8) + '...' : 'unknown',
      turnCount: message.turnCount
    });

    // Track live progress so the loading status card can show "N turns
    // captured so far…" while the user waits.
    if (typeof message.turnCount === 'number' && message.turnCount > state.capture.lastTurnCount) {
      state.capture.lastTurnCount = message.turnCount;
    }

    // Update UI immediately when notified
    debouncedCheckAndUpdateUI();
  });

  // Re-check the UI whenever the active tab finishes loading. This handles the
  // "clicked reload / Cmd+R" case where tab.url is briefly about:blank or the
  // destination URL is already set but the content script hasn't injected yet.
  if (browser.tabs && browser.tabs.onUpdated && browser.tabs.onUpdated.addListener) {
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (!state.currentTab || tabId !== state.currentTab.id) return;
      // On any navigation start (new URL or status flip to loading) clear the
      // capture-wait timer so the "stuck after 15 s timeout" case can't
      // persist across a reload while the popup stays open. Also reset the
      // live turn counter so the progress UI starts from 0.
      if (changeInfo.status === 'loading' || changeInfo.url) {
        state.capture.waitingSince = null;
        state.capture.waitingForId = null;
        state.capture.lastTurnCount = 0;
      }
      if (changeInfo.status === 'complete' || changeInfo.url) {
        debouncedCheckAndUpdateUI();
      }
    });
  }

  _console.log('[Popup] Event-driven updates enabled');
}

/**
 * React to an EXPORT_RESULT runtime message from background.js. These are
 * fire-and-forget — background sends them after the asynchronous download
 * resolves (success) or rejects (download_failed / processing_failed).
 *
 * When popup is still open, we repaint the status card so the user sees
 * the real outcome. When popup has closed (common on the 3-second auto-
 * close), the toolbar '!' badge set by background.js's catch is the
 * fallback signal. See docs/ux-audit.md §3.1 B1.
 *
 * @param {{outcome: string, platform?: string, reason?: string, filename?: string}} detail
 */
function handleExportResultMessage(detail) {
  if (!detail || typeof detail.outcome !== 'string') return;
  switch (detail.outcome) {
    case 'success':
      // Background confirmed the download. The sync-path "Export complete."
      // card may already be showing; re-affirm with the real filename and
      // open the review step.
      updateStatus(
        'success',
        'Export complete.',
        detail.filename
          ? `Saved to Downloads as ${detail.filename}`
          : 'Check your Downloads folder.'
      );
      updateExportButton(true);
      showReviewCard(detail);
      break;
    case 'download_failed':
      updateStatus(
        'error',
        'Download failed.',
        (detail.reason ? `${detail.reason}. ` : '') +
        'Check that your browser allows downloads for this site, and that the Downloads folder is writable, then try again.'
      );
      updateExportButton(true);
      break;
    case 'processing_failed':
      updateStatus(
        'error',
        'Could not build the export.',
        (detail.reason ? `${detail.reason}. ` : '') +
        'Reload the tab, wait for the conversation to finish loading, then try again.'
      );
      updateExportButton(true);
      break;
    case 'empty_export':
      updateStatus(
        'warning',
        'No messages to export.',
        'This conversation looks empty. Send at least one message, wait for the response to finish, then try again.'
      );
      updateExportButton(true);
      break;
    case 'invalid_data':
      updateStatus(
        'error',
        'The conversation data looks incomplete.',
        (detail.reason ? `${detail.reason}. ` : '') +
        'Reload the tab and let the conversation finish loading before exporting.'
      );
      updateExportButton(true);
      break;
    case 'auth_failed':
      renderAuthFailure(detail.platform, platformDisplayName(detail.platform));
      break;
    case 'auth_recovered':
      // User signed back in. Re-check UI state so the sign-in card is
      // replaced by the real export state (ready / loading / etc).
      debouncedCheckAndUpdateUI();
      break;
    default:
      // Unknown outcome — no-op; forward compat.
      break;
  }
}

// ============================================================================
// REVIEW-YOUR-EXPORT STEP
// ============================================================================

const reviewState = { downloadId: null };

/**
 * Show the post-export review card. The copy mentions the researcher only
 * when a study code is set, because only then is the participant exporting
 * for someone else. The "Show in Downloads" button reveals the ZIP via
 * browser.downloads.show(downloadId) when background supplied an id.
 *
 * @param {{filename?: string, downloadId?: number|null}} detail
 */
function showReviewCard(detail) {
  const card = document.getElementById('reviewCard');
  const body = document.getElementById('reviewCardBody');
  const showBtn = document.getElementById('reviewShowBtn');
  if (!card || !body || !showBtn) return;

  reviewState.downloadId = (detail && typeof detail.downloadId === 'number') ? detail.downloadId : null;

  const saltInput = document.getElementById('studySaltInput');
  const hasStudyCode = Boolean(saltInput && saltInput.value.trim());
  body.textContent = hasStudyCode
    ? "Open the ZIP and check what's in it before sharing it with the researcher."
    : "Open the ZIP and check what's in it before sharing it.";

  showBtn.hidden = reviewState.downloadId === null
    || !(browser.downloads && typeof browser.downloads.show === 'function');
  card.hidden = false;
  // The review step is the next action; put keyboard focus on it.
  if (!showBtn.hidden) showBtn.focus();
}

function hideReviewCard() {
  const card = document.getElementById('reviewCard');
  if (card) card.hidden = true;
  reviewState.downloadId = null;
}

function wireReviewCard() {
  const showBtn = document.getElementById('reviewShowBtn');
  if (!showBtn) return;
  showBtn.addEventListener('click', () => {
    if (reviewState.downloadId === null) return;
    try {
      browser.downloads.show(reviewState.downloadId).catch(() => {});
    } catch (_) { /* downloads.show unavailable; the file is still in Downloads */ }
  });
}

/**
 * Ask background whether this tab currently has a stored auth failure.
 * Returns {authFailed: boolean, platform?: string, where?: string, since?: number}
 * or null on error. Safe to call even when background hasn't booted yet;
 * the catch swallows the "no receiving end" case.
 */
async function fetchAuthStateForTab(tabId) {
  if (typeof tabId !== 'number') return null;
  try {
    return await browser.runtime.sendMessage({ type: 'GET_AUTH_STATE', tabId });
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a platform id to its human-readable name via EXTENSION_CONFIG,
 * with a fallback to a title-cased id if the lookup misses.
 */
function platformDisplayName(platformId) {
  const def = EXTENSION_CONFIG?.platforms?.[platformId];
  if (def && def.name) return def.name;
  return String(platformId || 'the platform').replace(/_/g, ' ');
}

/**
 * Repaint the status card for the auth-failed state. Platform-specific
 * copy comes from shared/errors.js via formatAuthFailureCopy().
 */
function renderAuthFailure(platformId, platformName) {
  const copy = formatAuthFailureCopy(platformName || platformDisplayName(platformId));
  updateStatus('error', copy.message, copy.detail);
  updateExportButton(false);
  hideFilePreview();
}

/**
 * Start fallback polling for status updates
 * Only used as fallback if event-driven updates don't work
 * @param {number} interval - Polling interval in milliseconds (default: 10000ms)
 */
function startPolling(interval = 10000) {
  // Don't start if already polling
  if (state.polling.isPolling) {
    return;
  }

  state.polling.isPolling = true;

  // Clear any existing interval
  if (state.polling.intervalId) {
    clearInterval(state.polling.intervalId);
  }

  // Set up new polling interval (much longer than before - 10s instead of 3s)
  state.polling.intervalId = setInterval(() => {
    debouncedCheckAndUpdateUI();
  }, interval);

  _console.log(`[Popup] Fallback polling started with ${interval}ms interval`);
}

/**
 * Debounced version of checkAndUpdateUI to prevent excessive updates
 * Uses a 300ms debounce delay
 */
function debouncedCheckAndUpdateUI() {
  // Clear any existing debounce timeout
  if (state.polling.debounceTimeout) {
    clearTimeout(state.polling.debounceTimeout);
  }

  // Set new debounce timeout
  state.polling.debounceTimeout = setTimeout(() => {
    const now = Date.now();
    const timeSinceLastUpdate = now - state.polling.lastUpdateTime;

    // Ensure minimum 200ms between actual updates
    if (timeSinceLastUpdate >= 200) {
      state.polling.lastUpdateTime = now;
      checkAndUpdateUI();
    }
  }, 300);
}

// ============================================================================
// STATUS CHECK AND UPDATE
// ============================================================================

/**
 * Check if conversation data is available for platforms that require it
 * @param {Object} tab - Browser tab object
 * @param {Object} platform - Platform object
 * @param {string} conversationId - Conversation ID
 * @returns {Promise<Object>} Object with hasData boolean and optional title
 */
async function checkConversationData(tab, platform, conversationId) {
  // Let communication errors propagate — the caller's catch handles them with
  // a CONTENT_SCRIPT_NOT_LOADED error. Never fail open here.
  const response = await browser.tabs.sendMessage(tab.id, {
    type: 'GET_CAPTURED_CONVERSATIONS'
  });

  if (response && response.success) {
    // New format with conversations array
    if (response.conversations) {
      const conversation = response.conversations.find(c => c.id === conversationId);
      return {
        hasData: !!conversation,
        title: conversation ? conversation.title : null,
        noOverviewForThisPage: !!response.noOverviewForThisPage
      };
    }

    // Backward compatibility
    if (response.conversationIds) {
      return {
        hasData: response.conversationIds.includes(conversationId),
        title: null,
        noOverviewForThisPage: !!response.noOverviewForThisPage
      };
    }
  }

  return { hasData: false, title: null, noOverviewForThisPage: false };
}

/**
 * Update UI based on current tab and platform detection
 */
async function checkAndUpdateUI() {
  hideGoogleTip();    // Only re-shown below when the active tab is Google
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });

    if (tabs.length === 0) {
      displayError('NO_ACTIVE_TAB');
      updatePlatformBadge(null);
      return;
    }

    const tab = tabs[0];
    const url = tab.url || '';

    // Store current tab in state
    state.currentTab = tab;

    // Tab is mid-navigation (reload in progress, DNS lookup, etc.). Show a
    // "waiting" state and let the next debounced check re-evaluate once the
    // navigation settles. We treat any of these as navigating:
    //   - tab.status === 'loading'
    //   - URL is blank / about: / file: — nothing we support
    // The tabs.onUpdated listener will re-fire checkAndUpdateUI when the tab
    // reaches 'complete'.
    const urlLooksTemporary = !url || url === 'about:blank' || url.startsWith('about:') || url.startsWith('data:');
    if (tab.status === 'loading' || urlLooksTemporary) {
      updateStatus('loading', 'Waiting for page to load…', 'The page is still loading.');
      updateExportButton(false);
      hideFilePreview();
      return;
    }

    // Detect platform
    const platform = detectPlatform(url);

    // For google_search, show AI Mode vs AI Overview distinctly in the badge
    // and surface the "close + reopen the popup" workflow tip. Google's AI
    // output renders asynchronously and the content script keeps capturing
    // in the background — making this behaviour visible saves users from
    // thinking the extension is stuck when it is actually mid-capture.
    if (platform && platform.id === 'google_search') {
      try {
        const isAIMode = new URL(url).searchParams.get('udm') === '50';
        if (isAIMode) platform.name = 'Google AI Mode';
      } catch { /* ignore */ }
      showGoogleTip();
    }

    // Update platform badge
    updatePlatformBadge(platform);

    // Update state
    state.platform.id = platform ? platform.id : null;
    state.platform.name = platform ? platform.name : null;

    if (!platform) {
      displayError('UNSUPPORTED_PLATFORM');
      hideFilePreview();
      return;
    }

    // Auth-failure short-circuit. Background tracks per-tab auth state so a
    // 401 that fired while the popup was closed still shows the sign-in
    // card next time the popup opens. See docs/ux-audit.md §3.1 B3.
    const authState = await fetchAuthStateForTab(tab.id);
    if (authState && authState.authFailed) {
      renderAuthFailure(authState.platform || platform.id, platform.name);
      return;
    }

    // Check if platform requires conversation ID
    const { hasConversationId, conversationId } = checkConversationId(platform, url);
    state.platform.conversationId = conversationId;

    // Platform-specific status logic
    if (platform.requiresConversationId && !hasConversationId) {
      // ChatGPT or Copilot without conversation ID
      displayError('NO_CONVERSATION_ID', {
        platformId: platform.id,
        customDetail: `Please open or start a conversation on ${platform.name}.`
      });
      hideFilePreview();
      return;
    }

    // For platforms that require conversation ID (ChatGPT, Copilot)
    if (platform.requiresConversationId && conversationId) {
      try {
        const { hasData, title } = await checkConversationData(tab, platform, conversationId);

        if (hasData) {
          // Data is ready for export — clear the loading timer
          state.capture.waitingSince = null;
          state.capture.waitingForId = null;
          updateStatus(
            'success',
            `Ready to export ${platform.name} conversation.`,
            'Click the button below to download the ZIP.'
          );
          updateExportButton(true);
          updateFilePreview(title || 'conversation');
        } else {
          const now = Date.now();
          // Reset timer when we move to a different conversation
          if (state.capture.waitingForId !== conversationId) {
            state.capture.waitingSince = now;
            state.capture.waitingForId = conversationId;
          }
          const elapsed = now - (state.capture.waitingSince || now);

          if (elapsed < CAPTURE_LOADING_TIMEOUT_MS) {
            // Brief loading phase — data may arrive any second. Show an
            // elapsed counter so the user knows the popup hasn't frozen.
            updateStatus(
              'loading',
              'Capturing conversation data…',
              formatStuckDetail({
                elapsedMs: elapsed,
                threshold: CAPTURE_LOADING_TIMEOUT_MS,
                mechanism: 'reload',
                platformName: platform.name
              })
            );
          } else {
            // Past the loading threshold — the extension only captures on
            // page load, so the user needs to reload the tab themselves.
            // The in-popup "Reload Page" button was removed in step 5
            // because reloading someone's tab from the popup bypasses
            // browser affordances (confirm-on-reload, scroll, form state).
            updateStatus(
              'info',
              'Still waiting on this page.',
              formatStuckDetail({
                elapsedMs: elapsed,
                threshold: CAPTURE_LOADING_TIMEOUT_MS,
                mechanism: 'reload',
                platformName: platform.name,
                stuck: true
              })
            );
          }
          updateExportButton(false);
          hideFilePreview();
        }
      } catch (error) {
        // Content script might not be loaded yet
        popupLogError('checkConversationData', error, { platformId: platform.id, conversationId });
        displayError('CONTENT_SCRIPT_NOT_LOADED', {
          platformId: platform.id,
          originalError: error
        });
        hideFilePreview();
      }
      return;
    }

    // For API interception platforms (Claude, Copilot without conversation ID)
    // These platforms capture data via local client-side API interception
    if (platform.id === 'claude') {
      updateStatus(
        'success',
        'Ready to export Claude conversation.',
        'Data is captured locally as you chat. Click below to export.'
      );
      updateExportButton(true);

      // Try to get title for Claude if available
      try {
        const { title } = await checkConversationData(tab, platform, state.platform.conversationId);
        updateFilePreview(title || 'conversation');
      } catch {
        updateFilePreview('conversation');
      }

    } else if (platform.id === 'perplexity') {
      updateStatus(
        'success',
        'Ready to export Perplexity thread.',
        'Data is captured locally as the thread loads. Click below to export.'
      );
      updateExportButton(true);
      try {
        const { title } = await checkConversationData(tab, platform, state.platform.conversationId);
        updateFilePreview(title || 'thread');
      } catch {
        updateFilePreview('thread');
      }

    } else if (platform.id === 'm365_copilot') {
      // M365 Copilot captures over SignalR WebSocket. The conversationId isn't
      // in the page URL — content.js tracks it per-socket and reports the
      // latest capture. Export is gated on `isComplete` so a mid-stream export
      // can't ship a half-written reply.
      try {
        const response = await browser.tabs.sendMessage(tab.id, { type: 'GET_CAPTURED_CONVERSATIONS' });
        const conversations = (response && Array.isArray(response.conversations))
          ? response.conversations
          : [];
        if (conversations.length === 0) {
          updateStatus(
            'info',
            'Waiting for M365 Copilot conversation.',
            'Open or start a chat and send a message — the extension captures as the response streams.'
          );
          updateExportButton(false);
          hideFilePreview();
        } else {
          // Pick the latest (array is in insertion order; last entry is newest).
          const latest = conversations[conversations.length - 1];
          if (latest.isComplete) {
            updateStatus(
              'success',
              'Ready to export M365 Copilot conversation.',
              'Click below to export the completed turn.'
            );
            updateExportButton(true);
            updateFilePreview(latest.title || 'conversation');
          } else {
            updateStatus(
              'loading',
              'Copilot is still replying…',
              'Export unlocks when the response finishes streaming.'
            );
            updateExportButton(false);
            hideFilePreview();
          }
        }
      } catch (error) {
        popupLogError('m365_copilot GET_CAPTURED_CONVERSATIONS', error, { platformId: platform.id });
        displayError('CONTENT_SCRIPT_NOT_LOADED', {
          platformId: platform.id,
          originalError: error
        });
        hideFilePreview();
      }

    } else if (platform.id === 'google_search') {
      // Google AI Overview / AI Mode: content script captures via DOM reads
      // and a MutationObserver — reloading the page actively hurts (clears
      // state, forces a race against client-side rendering).
      try {
        const query = state.platform.conversationId
          ? state.platform.conversationId.split('::')[0]
          : null;

        if (!query) {
          updateStatus(
            'info',
            'Run a search first.',
            'Open google.com/search and enter a query that returns an AI Overview.'
          );
          updateExportButton(false);
          hideFilePreview();
          return;
        }

        const { hasData, title, noOverviewForThisPage } = await checkConversationData(
          tab, platform, state.platform.conversationId
        );

        if (hasData) {
          stopCaptureTicker();
          const isAIMode = (() => {
            try { return new URL(tab.url).searchParams.get('udm') === '50'; } catch { return false; }
          })();
          updateStatus(
            'success',
            isAIMode ? 'Ready to export AI Mode conversation.' : 'Ready to export AI Overview.',
            isAIMode
              ? 'Each turn exports as a separate row. To capture newer turns, close and reopen this popup.'
              : `Query: "${query}"`
          );
          updateExportButton(true);
          updateFilePreview(title || (isAIMode
            ? `ai_mode_${query.slice(0, 32)}`
            : `ai_overview_${query.slice(0, 32)}`));
        } else if (noOverviewForThisPage) {
          const isAIMode = (() => {
            try { return new URL(tab.url).searchParams.get('udm') === '50'; } catch { return false; }
          })();
          updateStatus(
            'info',
            isAIMode ? 'No AI Mode turns detected yet.' : 'No AI Overview on this page.',
            isAIMode
              ? 'Ask a question in AI Mode, wait for the reply, then close and reopen this popup. After reopening, wait a second or two for the capture to show up.'
              : 'Try AI Mode (tab at top of results) or a query that triggers one.'
          );
          updateExportButton(false);
          hideFilePreview();
        } else {
          // No "loading" spinner here. The popup does not reliably flip from
          // loading → ready while it stays open — the content script captures
          // Google's AI output in the background and the popup only reads the
          // state at the moment it opens. Showing a progress UI would promise
          // something we don't deliver. Instead, give the user the single
          // instruction that actually works: close and reopen.
          stopCaptureTicker();
          const isAIMode = (() => {
            try { return new URL(tab.url).searchParams.get('udm') === '50'; } catch { return false; }
          })();
          updateStatus(
            'info',
            'Still waiting on this page.',
            formatStuckDetail({
              elapsedMs: CAPTURE_LOADING_TIMEOUT_MS, // past-threshold variant
              threshold: CAPTURE_LOADING_TIMEOUT_MS,
              mechanism: 'reopen',
              platformName: isAIMode ? 'Google AI Mode' : 'Google AI Overview',
              stuck: true
            })
          );
          updateExportButton(false);
          hideFilePreview();
        }
      } catch (error) {
        // Content script hasn't responded (e.g., page is reloading and the
        // script is still re-injecting). Same honest instruction: the popup
        // won't recover on its own while it stays open.
        popupLogError('checkConversationData', error, { platformId: platform.id });
        stopCaptureTicker();
        updateStatus(
          'info',
          'Still waiting on this page.',
          formatStuckDetail({
            elapsedMs: CAPTURE_LOADING_TIMEOUT_MS,
            threshold: CAPTURE_LOADING_TIMEOUT_MS,
            mechanism: 'reopen',
            platformName: 'Google',
            stuck: true
          })
        );
        updateExportButton(false);
        hideFilePreview();
      }

    } else {
      // Fallback for any other platforms
      updateStatus(
        'success',
        `Ready to export ${platform.name} conversation.`,
        'Click the button below to download the ZIP.'
      );
      updateExportButton(true);
      updateFilePreview('conversation');
    }
  } catch (error) {
    popupLogError('checkAndUpdateUI', error);
    displayError('UNKNOWN_ERROR', {
      originalError: error,
      customDetail: 'Error accessing tab information. Please try closing and reopening the popup.'
    });
    hideFilePreview();
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handle export button click with rate limiting
 */
/**
 * Warn the donor before exporting a very large conversation. Returns true
 * when the user wants to proceed, false to cancel. We rely on the content
 * script's conversation list already in state for an approximate size signal;
 * if we don't have one, we skip the warning.
 */
const LARGE_CONVERSATION_THRESHOLD = 500;
/**
 * Prompt the user to confirm a large-conversation export. Replaces the
 * previous window.confirm with an in-popup confirmation card that:
 *   - matches the popup's visual language (warning card styling),
 *   - can't be suppressed by Firefox's "disable future dialogs" button,
 *   - keeps keyboard focus inside the popup (Esc cancels, Enter confirms
 *     because focus starts on the "Export anyway" button),
 *   - returns a Promise instead of a sync bool so callers compose cleanly.
 * Resolves true if the user clicks "Export anyway" (or the conversation
 * isn't large), false if they click "Cancel" or press Esc.
 */
function confirmLargeExport() {
  const captured = state.capture?.conversations || [];
  const selectedId = state.platform?.conversationId;
  const selected = captured.find(c => c.id === selectedId);
  const size = selected?.messageCount ?? selected?.message_count ?? null;
  if (size === null || size < LARGE_CONVERSATION_THRESHOLD) return Promise.resolve(true);

  const card = document.getElementById('largeExportConfirm');
  const bodyText = document.getElementById('largeExportConfirmBodyText');
  const proceedBtn = document.getElementById('largeExportConfirmProceed');
  const cancelBtn = document.getElementById('largeExportConfirmCancel');
  if (!card || !proceedBtn || !cancelBtn) return Promise.resolve(true);

  if (bodyText) {
    bodyText.textContent =
      `This conversation has about ${size} messages. Exporting may take a few seconds and the ZIP will include every turn.`;
  }

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement;
    const cleanup = (result) => {
      card.hidden = true;
      proceedBtn.removeEventListener('click', onProceed);
      cancelBtn.removeEventListener('click', onCancel);
      card.removeEventListener('keydown', onKeydown);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
      resolve(result);
    };
    const onProceed = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onKeydown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation(); // don't let handlePopupEscape close the whole popup
        cleanup(false);
      }
    };
    proceedBtn.addEventListener('click', onProceed);
    cancelBtn.addEventListener('click', onCancel);
    card.addEventListener('keydown', onKeydown);
    card.hidden = false;
    // Focus the destructive-ish primary so Enter confirms, matching the
    // native-confirm default. Cancel is one Tab away.
    proceedBtn.focus();
  });
}

async function handleExportClick() {
  if (!(await confirmLargeExport())) return;
  const now = Date.now();

  // Rate limiting check 1: Minimum interval between exports
  const timeSinceLastExport = now - exportRateLimit.lastExport;
  if (timeSinceLastExport < exportRateLimit.minInterval) {
    const waitTime = Math.ceil((exportRateLimit.minInterval - timeSinceLastExport) / 1000);
    updateStatus(
      'warning',
      'Please wait before exporting again',
      `Rate limit: Please wait ${waitTime} second${waitTime !== 1 ? 's' : ''} between exports.`
    );
    popupLogError('handleExportClick', 'Rate limit: minimum interval', {
      timeSinceLastExport,
      minInterval: exportRateLimit.minInterval
    });
    return;
  }

  // Rate limiting check 2: Maximum exports per minute
  // Clean up old exports (older than 60 seconds)
  exportRateLimit.recentExports = exportRateLimit.recentExports.filter(
    timestamp => now - timestamp < 60000
  );

  if (exportRateLimit.recentExports.length >= exportRateLimit.maxExportsPerMinute) {
    const oldestExport = Math.min(...exportRateLimit.recentExports);
    const waitTime = Math.ceil((60000 - (now - oldestExport)) / 1000);
    updateStatus(
      'error',
      'Too many exports',
      `Rate limit: Maximum ${exportRateLimit.maxExportsPerMinute} exports per minute. Please wait ${waitTime} second${waitTime !== 1 ? 's' : ''}.`
    );
    popupLogError('handleExportClick', 'Rate limit: max per minute exceeded', {
      recentExportsCount: exportRateLimit.recentExports.length,
      maxExportsPerMinute: exportRateLimit.maxExportsPerMinute
    });
    return;
  }

  // Prevent multiple simultaneous exports
  if (state.export.isExporting) {
    popupLogError('handleExportClick', 'Export already in progress', { isExporting: true });
    return;
  }

  // Update rate limit tracking
  exportRateLimit.lastExport = now;
  exportRateLimit.recentExports.push(now);

  state.export.isExporting = true;
  state.export.lastError = null; // Clear previous error
  hideReviewCard();

  // Show loading state with spinner in button
  updateExportButton(false, 'Exporting...', true);
  updateStatus('loading', 'Exporting conversation...', 'Please wait.');

  try {
    const tab = state.currentTab;

    if (!tab) {
      throw new Error('NO_ACTIVE_TAB');
    }

    const platform = detectPlatform(tab.url);

    if (!platform) {
      throw new Error('UNSUPPORTED_PLATFORM');
    }

    // Build export message
    const exportMessage = {
      type: 'EXPORT_CONVERSATION',
      platform: platform.id
    };

    // Attach the conversation ID when we have one. We previously only did
    // this for platforms where `requiresConversationId` is true, which left
    // Google Search exports with `conversationId: undefined` — the content
    // script then couldn't look up the already-captured data and fell back
    // to re-scanning the live DOM, which fails whenever the AI Mode page
    // has drifted since capture.
    const conversationId = state.platform.conversationId;
    if (platform.requiresConversationId && !conversationId) {
      throw new Error('NO_CONVERSATION_ID');
    }
    if (conversationId) {
      exportMessage.conversationId = conversationId;
    }

    popupLogDebug('handleExportClick', 'Starting export', {
      platform: platform.id,
      hasConversationId: !!exportMessage.conversationId,
      tabId: tab.id
    });

    // Send export request to content script
    let response;
    try {
      response = await browser.tabs.sendMessage(tab.id, exportMessage);
    } catch (messageError) {
      // Content script communication error
      popupLogError('handleExportClick', messageError, {
        platform: platform.id,
        messageType: 'EXPORT_CONVERSATION'
      });

      // Determine specific error type
      if (messageError.message && messageError.message.includes('Receiving end does not exist')) {
        throw new Error('CONTENT_SCRIPT_NOT_LOADED');
      } else if (messageError.message && messageError.message.includes('permission')) {
        throw new Error('PERMISSION_DENIED');
      } else {
        throw new Error('NETWORK_ERROR');
      }
    }

    if (response && response.success) {
      // Export successful
      popupLogDebug('handleExportClick', 'Export completed successfully', {
        platform: platform.id,
        conversationId: exportMessage.conversationId
      });

      // The content script handed the data to background; background's
      // EXPORT_RESULT follows with the real outcome, the file name and the
      // review step. The popup stays open so the user can read it.
      updateStatus(
        'success',
        'Export complete.',
        'Check your Downloads folder.'
      );

      // Reset button to normal state (no spinner)
      updateExportButton(false, 'Export ZIP', false);
    } else {
      // Export failed with error from content script
      const errorMessage = response?.error || 'Unknown error occurred';
      const sanitizedError = sanitizeErrorMessage(errorMessage);

      popupLogError('handleExportClick', `Export failed: ${errorMessage}`, {
        platform: platform.id,
        response
      });

      // Check for specific error patterns
      if (errorMessage.toLowerCase().includes('no data') ||
        errorMessage.toLowerCase().includes('no conversation') ||
        errorMessage.toLowerCase().includes('empty')) {
        throw new Error('NO_DATA_AVAILABLE');
      } else {
        throw new Error(`EXPORT_FAILED:${sanitizedError}`);
      }
    }
  } catch (error) {
    const errorMessage = error.message || 'UNKNOWN_ERROR';

    // Reset export state
    state.export.isExporting = false;
    hideReviewCard();

    // Reset button to normal state (remove spinner)
    updateExportButton(true, 'Export ZIP', false);

    // Handle specific error types
    if (errorMessage === 'NO_ACTIVE_TAB') {
      displayError('NO_ACTIVE_TAB', { originalError: error });
    } else if (errorMessage === 'UNSUPPORTED_PLATFORM') {
      displayError('UNSUPPORTED_PLATFORM', { originalError: error });
    } else if (errorMessage === 'NO_CONVERSATION_ID') {
      displayError('NO_CONVERSATION_ID', {
        platformId: state.platform.id,
        originalError: error
      });
    } else if (errorMessage === 'CONTENT_SCRIPT_NOT_LOADED') {
      displayError('CONTENT_SCRIPT_NOT_LOADED', {
        platformId: state.platform.id,
        originalError: error
      });
    } else if (errorMessage === 'PERMISSION_DENIED') {
      displayError('PERMISSION_DENIED', {
        platformId: state.platform.id,
        originalError: error
      });
    } else if (errorMessage === 'NETWORK_ERROR') {
      displayError('NETWORK_ERROR', {
        platformId: state.platform.id,
        originalError: error
      });
    } else if (errorMessage === 'NO_DATA_AVAILABLE') {
      displayError('NO_DATA_AVAILABLE', {
        platformId: state.platform.id,
        originalError: error
      });
    } else if (errorMessage.startsWith('EXPORT_FAILED:')) {
      const customDetail = errorMessage.replace('EXPORT_FAILED:', '');
      displayError('EXPORT_FAILED', {
        platformId: state.platform.id,
        customDetail: customDetail,
        originalError: error
      });
    } else {
      // Unknown error - sanitize and display
      const sanitizedError = sanitizeErrorMessage(errorMessage);
      displayError('UNKNOWN_ERROR', {
        platformId: state.platform.id,
        customDetail: sanitizedError,
        originalError: error
      });
    }
  }
}

// ============================================================================
// KEYBOARD NAVIGATION
// ============================================================================

/**
 * Handle keyboard events for accessibility
 * Ensures Enter and Space keys work on all interactive elements
 * @param {KeyboardEvent} event - Keyboard event
 */
function handleKeyboardNavigation(event) {
  const target = event.target;

  // Handle Enter and Space keys on buttons (native behavior, but ensure consistency)
  if (target.tagName === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    target.click();
  }

  // Handle Enter and Space keys on summary elements (native behavior, but ensure consistency)
  if (target.tagName === 'SUMMARY' && (event.key === 'Enter' || event.key === ' ')) {
    // Native behavior handles this, but we can add custom logic if needed
    // For now, let the native behavior work
  }
}

/**
 * Close the browser-action popup on Escape.
 *
 * Firefox desktop does NOT close the browserAction popup on Esc natively
 * (unlike Chrome). Verified against bugzilla + behavior in the harness;
 * see docs/ux-audit.md §3.1 M4. We attach an explicit handler so keyboard
 * users get the expected affordance. The handler is a no-op if the user
 * is typing in the study-code <input> — Esc there just blurs the field.
 *
 * @param {KeyboardEvent} event
 */
function handlePopupEscape(event) {
  if (event.key !== 'Escape') return;
  const target = event.target;
  // Esc inside a text field should clear focus, not close the popup. Users
  // may be editing the study code; closing on Esc there would be hostile.
  if (target && target.tagName === 'INPUT' && target.type === 'text') {
    target.blur();
    event.preventDefault();
    return;
  }
  event.preventDefault();
  window.close();
}

/**
 * Move focus to a sensible first-focus target when the popup opens.
 *
 * The browser leaves focus on <body> by default when a popup opens, so
 * keyboard users have to tab in from nothing. Picking the primary action
 * for the current state removes that step:
 *   - consent gate shown   → focus the consent checkbox
 *   - export button enabled → focus the export button
 *   - fallback              → focus the first focusable button
 */
function focusInitialTarget() {
  // Give the DOM one tick in case checkAndUpdateUI is still toggling
  // disabled attributes between render phases.
  requestAnimationFrame(() => {
    const consentCheckbox = document.getElementById('consentCheckbox');
    if (consentCheckbox && !consentCheckbox.disabled && consentCheckbox.offsetParent !== null) {
      consentCheckbox.focus();
      return;
    }
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn && !exportBtn.disabled) {
      exportBtn.focus();
      return;
    }
    // Nothing primary to focus — leave focus on <body>, user tabs in.
  });
}

/**
 * Verify no keyboard traps exist
 * Ensures all focusable elements can be reached and exited via keyboard
 * @returns {boolean} True if no keyboard traps detected
 */
function verifyNoKeyboardTraps() {
  const focusableElements = document.querySelectorAll(
    'button:not([disabled]), summary, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );

  if (focusableElements.length === 0) {
    _console.warn('No focusable elements found');
    return false;
  }

  // Check that all focusable elements are reachable
  let allReachable = true;
  focusableElements.forEach((element) => {
    // Check if element is visible and not hidden
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return; // Skip hidden elements
    }

    // Check if element has proper tabindex
    const tabindex = element.getAttribute('tabindex');
    if (tabindex && parseInt(tabindex) < 0) {
      _console.warn(`Element ${element.tagName} has negative tabindex:`, element);
      allReachable = false;
    }
  });

  _console.log(`Keyboard navigation check: ${focusableElements.length} focusable elements found`);
  return allReachable;
}

/**
 * Set up proper tab order for all interactive elements
 * Ensures logical navigation flow through the popup
 */
function setupTabOrder() {
  // Get all interactive elements in the desired tab order
  const exportBtn = document.getElementById('exportBtn');
  const infoSection = document.getElementById('infoSection');
  const infoToggle = infoSection?.querySelector('summary');

  // Ensure elements have proper tabindex (0 for natural tab order)
  // Native elements like button and summary already have proper tab order
  // This is just a verification step

  if (exportBtn) {
    // Button already has natural tab order
    exportBtn.setAttribute('tabindex', '0');
  }

  if (infoToggle) {
    // Summary already has natural tab order
    infoToggle.setAttribute('tabindex', '0');
  }

  _console.log('Tab order configured for keyboard navigation');
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Check whether the user has previously given consent.
 * @returns {Promise<boolean>}
 */
async function checkConsent() {
  try {
    const stored = await browser.storage.local.get('consent_given');
    return stored.consent_given === true;
  } catch {
    return false;
  }
}

/**
 * Show the consent panel and hide main content until the user agrees.
 * Wires up the checkbox → button enable logic and the accept handler.
 */
function showConsentPanel() {
  const consentPanel = document.getElementById('consentPanel');
  const mainContent = document.querySelector('.popup-main');
  const footer = document.querySelector('.popup-footer');

  consentPanel.hidden = false;
  mainContent.hidden = true;
  footer.hidden = true;

  const checkbox = document.getElementById('consentCheckbox');
  const consentBtn = document.getElementById('consentBtn');

  checkbox.addEventListener('change', () => {
    consentBtn.disabled = !checkbox.checked;
  });

  consentBtn.addEventListener('click', async () => {
    if (!checkbox.checked) return;

    try {
      await browser.storage.local.set({ consent_given: true });
    } catch {
      // Storage failure is non-fatal — extension still works this session
    }

    consentPanel.hidden = true;
    mainContent.hidden = false;
    footer.hidden = false;

    initMainUI();
  });
}

/**
 * Load privacy settings from storage and apply them to the UI controls.
 */
async function hydratePrivacySettings() {
  try {
    const s = await browser.storage.local.get([
      'pii_scrub_enabled',
      'include_donor_context',
      'study_salt'
    ]);
    const scrub = document.getElementById('piiScrubCheckbox');
    const donorCtx = document.getElementById('donorContextCheckbox');
    const salt = document.getElementById('studySaltInput');
    if (scrub) scrub.checked = Boolean(s.pii_scrub_enabled);
    if (donorCtx) donorCtx.checked = s.include_donor_context !== false;
    if (salt && typeof s.study_salt === 'string') salt.value = s.study_salt;
  } catch { /* storage unavailable — leave defaults */ }
}

/**
 * Wire change handlers so toggles persist immediately.
 */
function wirePrivacySettings() {
  const scrub = document.getElementById('piiScrubCheckbox');
  const donorCtx = document.getElementById('donorContextCheckbox');
  const salt = document.getElementById('studySaltInput');
  if (scrub) scrub.addEventListener('change', () => {
    browser.storage.local.set({ pii_scrub_enabled: scrub.checked }).catch(() => {});
  });
  if (donorCtx) donorCtx.addEventListener('change', () => {
    browser.storage.local.set({ include_donor_context: donorCtx.checked }).catch(() => {});
  });
  if (salt) salt.addEventListener('change', () => {
    const v = salt.value.trim().slice(0, 256);
    browser.storage.local.set({ study_salt: v }).catch(() => {});
  });
}

/**
 * Initialize popup UI (runs only after consent is confirmed).
 */
function initMainUI() {
  const exportBtn = document.getElementById('exportBtn');
  exportBtn.addEventListener('click', handleExportClick);

  document.addEventListener('keydown', handleKeyboardNavigation);
  // Esc handler is attached in init() so it also fires on the consent panel.

  setupTabOrder();
  verifyNoKeyboardTraps();
  setupEventDrivenUpdates();
  checkAndUpdateUI();

  hydratePrivacySettings();
  wirePrivacySettings();
  wireReviewCard();

  wirePreviewBanner();

  startPolling(2000);
  verifyRuntimeIntegrity();
  focusInitialTarget();
}

/**
 * Show the "Development Preview" banner on first open and hide it on
 * subsequent opens once dismissed. The permanent small `Preview` tag in
 * the header stays regardless — see docs/ux-audit.md §3.1 B4.
 */
async function wirePreviewBanner() {
  const banner = document.getElementById('previewBanner');
  const dismiss = document.getElementById('previewBannerDismiss');
  if (!banner || !dismiss) return;
  try {
    const stored = await browser.storage.local.get('preview_banner_dismissed');
    if (stored.preview_banner_dismissed === true) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
  } catch (_) {
    // storage.local failed — show the banner by default; it's informational.
    banner.hidden = false;
  }
  dismiss.addEventListener('click', async () => {
    banner.hidden = true;
    try {
      await browser.storage.local.set({ preview_banner_dismissed: true });
    } catch (_) { /* best-effort: the banner will reappear next session */ }
  });
}

/**
 * Entry point — gate the main UI behind first-run consent.
 */
async function init() {
  // Escape should close the popup even on the consent panel. Attach the
  // listener here (not just in initMainUI) so first-run users can
  // dismiss with the keyboard.
  document.addEventListener('keydown', handlePopupEscape);

  const consentGiven = await checkConsent();
  if (!consentGiven) {
    showConsentPanel();
    focusInitialTarget();
    return;
  }
  initMainUI();
}

// ============================================================================
// RUNTIME INTEGRITY VERIFICATION
// ============================================================================

/**
 * Verify critical browser APIs and functions haven't been tampered with
 * This provides defense-in-depth against runtime manipulation
 */
function verifyRuntimeIntegrity() {
  const results = {
    passed: [],
    failed: []
  };

  // Check critical browser APIs
  const criticalAPIs = [
    { name: 'browser.tabs.query', obj: browser?.tabs, prop: 'query' },
    { name: 'browser.runtime.sendMessage', obj: browser?.runtime, prop: 'sendMessage' },
    { name: 'browser.downloads.download', obj: browser?.downloads, prop: 'download' },
    { name: 'document.createElement', obj: document, prop: 'createElement' },
    { name: 'JSON.parse', obj: JSON, prop: 'parse' },
    { name: 'JSON.stringify', obj: JSON, prop: 'stringify' }
  ];

  for (const api of criticalAPIs) {
    if (!api.obj) {
      results.failed.push({ name: api.name, reason: 'Parent object not found' });
      continue;
    }

    const value = api.obj[api.prop];
    if (typeof value !== 'function') {
      results.failed.push({ name: api.name, reason: 'API not found or not a function' });
    } else {
      results.passed.push(api.name);
    }
  }

  // Check critical functions exist
  const criticalFunctions = [
    'detectPlatform',
    'sanitizeErrorMessage'
  ];

  for (const funcName of criticalFunctions) {
    if (typeof window[funcName] === 'function') {
      results.passed.push(funcName);
    } else {
      results.failed.push({ name: funcName, reason: 'Function not found' });
    }
  }

  // Log results
  if (results.failed.length === 0) {
    _console.log('[Integrity] Runtime integrity verified:', results.passed.length, 'checks passed');
  } else {
    _console.error('[Integrity] Runtime integrity check failed:', results.failed);
  }

  return results.failed.length === 0;
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  init().catch(error => {
    _console.error('[Popup] Unhandled error during init:', error);
  });
});
