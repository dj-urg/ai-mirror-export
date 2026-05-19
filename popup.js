/**
 * popup.js - Popup UI Logic
 *
 * Multi-platform UI that:
 * 1. Detects which platform the user is on
 * 2. Shows status of captured conversations
 * 3. Triggers export when user clicks button
 */

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

};

// ============================================================================
// ERROR HANDLING CONFIGURATION
// ============================================================================

// Error taxonomy and platform troubleshooting are defined in shared/errors.js
// (loaded via popup.html). See shared/errors.js for ERROR_TYPES and
// PLATFORM_TROUBLESHOOTING.

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
  }
};

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
// SHARED CONFIGURATION LOADING (from config/settings.js)
// ============================================================================

import { EXTENSION_CONFIG, getPlatformByUrl } from './config/settings.js';


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
      console.warn('[Security] Invalid URL scheme detected:', parsedUrl.protocol, 'for URL:', url);
      return null;
    }

    const hostname = parsedUrl.hostname;

    // Validate hostname is not empty
    if (!hostname || hostname.trim() === '') {
      console.warn('[Security] Empty hostname detected in URL:', url);
      return null;
    }

    if (typeof getPlatformByUrl !== 'function') {
      console.error('Configuration not loaded: getPlatformByUrl is not available');
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
    console.error('Error parsing URL:', error);
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
  if (!platform || !platform.requiresConversationId) {
    return { hasConversationId: true, conversationId: null };
  }

  const conversationId = platform.extractConversationId(url);
  return {
    hasConversationId: conversationId !== null,
    conversationId: conversationId
  };
}

// ============================================================================
// ERROR HANDLING UTILITIES
// ============================================================================

/**
 * Sanitization of error messages is handled by shared/errors.js.
 * This file relies on the global sanitizeErrorMessage defined there.
 */

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

  if (typeof logError === 'function') {
    logError('popup', errorMessage, logData);
  } else {
    console.error('[popup] [ERROR]', errorMessage, logData);
  }
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

  if (typeof logDebug === 'function') {
    logDebug('popup', message, logData);
  } else {
    console.log('[popup] [DEBUG]', message, logData);
  }
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
  let detailMessage = customDetail || errorConfig.detail;

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
    console.error(`Invalid status type: ${type}. Using 'info' as fallback.`);
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
  console.log(`Status updated: [${type}] ${message}${detail ? ' - ' + detail : ''}`);
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
  const targetText = text || 'Export to CSV';
  const hasTextChanged = currentText !== targetText;
  const hasSpinnerChanged = buttonIcon.classList.contains('spinner') !== showSpinner;

  // Update state
  const previousCanExport = state.export.canExport;
  state.export.canExport = enabled;

  // Stop polling when export button becomes enabled
  if (enabled && !previousCanExport) {
    stopPolling();
  }

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
        desc: 'Title, model, statistics, user profile'
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
        desc: 'Cited sources \u2014 only if searches were made',
        optional: true
      }
    ];
  } else {
    const sanitizedTitle = (title || 'conversation')
      .replace(/[^a-z0-9\u00a0-\uffff_-]/gi, '_').trim();
    files = [
      {
        badge: 'Export',
        badgeClass: 'default',
        name: sanitizedTitle || 'conversation',
        desc: `${platformName} conversation`
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
}

/**
 * Hide the file list panel
 */
function hideFilePreview() {
  const fileList = document.getElementById('fileList');
  if (fileList) {
    fileList.style.display = 'none';
  }
}

// ============================================================================
// EVENT-DRIVEN UPDATE MECHANISM (with fallback polling)
// ============================================================================

/**
 * Set up event-driven updates from content scripts
 * Content scripts notify popup when conversation data is captured
 */
function setupEventDrivenUpdates() {
  browser.runtime.onMessage.addListener((message, sender) => {
    // Only process CONVERSATION_READY messages
    if (message.type !== 'CONVERSATION_READY') {
      return;
    }

    // Validate sender is from our extension
    if (!sender || sender.id !== browser.runtime.id) {
      console.warn('[Popup] Ignoring CONVERSATION_READY from unauthorized sender');
      return;
    }

    console.log('[Popup] Conversation ready notification received', {
      platform: message.platform,
      conversationId: message.conversationId ? message.conversationId.substring(0, 8) + '...' : 'unknown'
    });

    // Update UI immediately when notified
    debouncedCheckAndUpdateUI();

    // Stop polling once we receive data (export button will be enabled)
    // Polling will be stopped by updateExportButton when button becomes enabled
  });

  console.log('[Popup] Event-driven updates enabled');
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

  console.log(`[Popup] Fallback polling started with ${interval}ms interval`);
}

/**
 * Stop polling for status updates
 */
function stopPolling() {
  if (!state.polling.isPolling) {
    return;
  }

  state.polling.isPolling = false;

  if (state.polling.intervalId) {
    clearInterval(state.polling.intervalId);
    state.polling.intervalId = null;
  }

  // Clear any pending debounce timeout
  if (state.polling.debounceTimeout) {
    clearTimeout(state.polling.debounceTimeout);
    state.polling.debounceTimeout = null;
  }

  console.log('[Popup] Polling stopped');
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
  try {
    const response = await browser.tabs.sendMessage(tab.id, {
      type: 'GET_CAPTURED_CONVERSATIONS'
    });

    if (response && response.success) {
      // New format with conversations array
      if (response.conversations) {
        const conversation = response.conversations.find(c => c.id === conversationId);
        return {
          hasData: !!conversation,
          title: conversation ? conversation.title : null
        };
      }

      // Backward compatibility
      if (response.conversationIds) {
        return {
          hasData: response.conversationIds.includes(conversationId),
          title: null
        };
      }
    }

    // If no response or no conversation IDs, assume data is available but unknown title
    return { hasData: true, title: null };
  } catch (error) {
    // If content script not responding, assume data is available
    console.log('Content script not responding, assuming data available');
    return { hasData: true, title: null };
  }
}

/**
 * Update UI based on current tab and platform detection
 */
async function checkAndUpdateUI() {
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

    // Detect platform
    const platform = detectPlatform(url);

    // Update platform badge
    updatePlatformBadge(platform);

    // Update state
    state.platform.id = platform ? platform.id : null;
    state.platform.name = platform ? platform.name : null;

    if (!platform) {
      displayError('UNSUPPORTED_PLATFORM');
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
      return;
    }

    // For platforms that require conversation ID (ChatGPT, Copilot)
    if (platform.requiresConversationId && conversationId) {
      try {
        const { hasData, title } = await checkConversationData(tab, platform, conversationId);

        if (hasData) {
          // Data is ready for export
          updateStatus(
            'success',
            `Ready to export ${platform.name} conversation.`,
            'Click the button below to download as CSV.'
          );
          updateExportButton(true);
          updateFilePreview(title || 'conversation');
        } else {
          // Waiting for conversation data to load
          updateStatus(
            'loading',
            `Loading ${platform.name} conversation data...`,
            'Please wait while the conversation loads.'
          );
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
      } catch (e) {
        updateFilePreview('conversation');
      }

    } else {
      // Fallback for any other platforms
      updateStatus(
        'success',
        `Ready to export ${platform.name} conversation.`,
        'Click the button below to download as CSV.'
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
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handle export button click with rate limiting
 */
async function handleExportClick() {
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

    // Add conversation ID if required
    if (platform.requiresConversationId) {
      const conversationId = state.platform.conversationId;

      if (!conversationId) {
        throw new Error('NO_CONVERSATION_ID');
      }

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

      updateStatus(
        'success',
        'Export complete!',
        'Check your Downloads folder.'
      );

      // Reset button to normal state (no spinner)
      updateExportButton(false, 'Export to CSV', false);

      // Auto-close after 2 seconds
      setTimeout(() => {
        window.close();
      }, 2000);
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

    // Reset button to normal state (remove spinner)
    updateExportButton(true, 'Export to CSV', false);

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
 * Ensure focus is maintained during UI state changes
 * Prevents focus loss when status updates or button state changes
 */
function maintainFocus() {
  const activeElement = document.activeElement;

  // If focus is on an element that's about to be updated, maintain focus
  if (activeElement && activeElement.id) {
    // Store the focused element ID
    const focusedId = activeElement.id;

    // After DOM updates, restore focus if the element still exists
    requestAnimationFrame(() => {
      const element = document.getElementById(focusedId);
      if (element && element !== document.activeElement) {
        // Only restore focus if it was lost
        if (document.activeElement === document.body) {
          element.focus();
        }
      }
    });
  }
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
    console.warn('No focusable elements found');
    return false;
  }

  // Check that all focusable elements are reachable
  let allReachable = true;
  focusableElements.forEach((element, index) => {
    // Check if element is visible and not hidden
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return; // Skip hidden elements
    }

    // Check if element has proper tabindex
    const tabindex = element.getAttribute('tabindex');
    if (tabindex && parseInt(tabindex) < 0) {
      console.warn(`Element ${element.tagName} has negative tabindex:`, element);
      allReachable = false;
    }
  });

  console.log(`Keyboard navigation check: ${focusableElements.length} focusable elements found`);
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

  console.log('Tab order configured for keyboard navigation');
}

/**
 * Handle focus management during state changes
 * Ensures focus is not lost when UI updates
 */
function handleFocusDuringStateChange() {
  // Store the currently focused element before state change
  const activeElement = document.activeElement;
  const activeElementId = activeElement?.id;

  // Return a function to restore focus after state change
  return () => {
    if (activeElementId) {
      const element = document.getElementById(activeElementId);
      if (element && document.activeElement === document.body) {
        // Focus was lost, restore it
        element.focus();
      }
    }
  };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize popup UI
 */
async function init() {
  // Configuration is now loaded via static import
  // await loadConfigModule();

  // Set up event listeners
  const exportBtn = document.getElementById('exportBtn');
  exportBtn.addEventListener('click', handleExportClick);

  // Set up keyboard navigation
  document.addEventListener('keydown', handleKeyboardNavigation);

  // Set up proper tab order
  setupTabOrder();

  // Verify no keyboard traps
  verifyNoKeyboardTraps();

  // Set up event-driven updates (primary mechanism)
  setupEventDrivenUpdates();

  // Initial UI update
  checkAndUpdateUI();

  // Start fallback polling with longer interval (10 seconds instead of 3)
  // Event-driven updates are the primary mechanism, polling is just a fallback
  // Polling will automatically stop when export button is enabled
  startPolling(10000);

  // Runtime integrity verification
  verifyRuntimeIntegrity();
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
    'sanitizeErrorMessage',
    'checkRateLimit'
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
    console.log('[Integrity] Runtime integrity verified:', results.passed.length, 'checks passed');
  } else {
    console.error('[Integrity] Runtime integrity check failed:', results.failed);
  }

  return results.failed.length === 0;
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  init().catch(error => {
    console.error('[Popup] Unhandled error during init:', error);
  });
});
