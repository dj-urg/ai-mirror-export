/**
 * General Settings and Configuration
 *
 * Central configuration for the extension including:
 * - Supported platforms and their domains
 * - Extension metadata
 * - Default settings
 */

export const EXTENSION_CONFIG = {
  // Extension metadata
  name: 'AI Chat Exporter',
  version: '2.0.0',
  description:
    'Export conversations from ChatGPT, Claude, and Co-pilot to CSV. All processing happens locally in your browser.',

  // Supported platforms
  // IMPORTANT: Platform objects must NOT contain an 'id' property.
  // The 'id' is always derived from the object key by getPlatformByUrl() and getEnabledPlatforms().
  platforms: {
    chatgpt: {
      name: 'ChatGPT',
      domains: ['chatgpt.com', 'chat.openai.com'],
      enabled: true,
      contentScript: 'platforms/chatgpt/content.js',
      injectScript: 'platforms/chatgpt/inject.js',
      backgroundHandler: 'chatgpt'
    },
    claude: {
      name: 'Claude',
      domains: ['claude.ai'],
      enabled: true,
      contentScript: 'platforms/claude/content.js',
      injectScript: 'platforms/claude/inject.js',
      backgroundHandler: 'ClaudeHandler'
    },
    copilot: {
      name: 'Co-pilot',
      domains: ['copilot.microsoft.com', 'copilotstudio.microsoft.com'],
      enabled: true,
      contentScript: 'platforms/copilot/content.js',
      injectScript: 'platforms/copilot/inject.js',
      backgroundHandler: 'copilot'
    }
  },

  // CSV export settings
  csv: {
    includeBOM: true, // UTF-8 BOM for Excel compatibility
    dateFormat: 'YYYY-MM-DD_HH-MM-SS',
    filenamePrefix: 'conversation_export'
  },

  // Debug settings
  debug: {
    enabled: false, // Set to true for verbose logging
    logLevel: 'info' // 'debug', 'info', 'warn', 'error'
  }
};

/**
 * @typedef {Object} PlatformDescriptor
 * @property {string} id                     Platform identifier (e.g., 'chatgpt', 'claude')
 * @property {string} name                   Platform display name
 * @property {string[]} domains              Supported domains
 * @property {boolean} enabled               Whether platform is enabled
 * @property {string} contentScript          Path to content script
 * @property {string} [injectScript]         Path to inject script (optional)
 * @property {string} backgroundHandler      Background handler identifier
 */

/**
 * Check if a hostname matches a domain (exact or subdomain).
 * @param {string} hostname - The hostname to check.
 * @param {string} domain - The domain to match against.
 * @returns {boolean} True if hostname matches domain or is a subdomain.
 */
function matchesDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Get platform configuration by URL.
 * @param {string} url - The URL to check.
 * @returns {PlatformDescriptor | null} Platform config with id, or null if not supported.
 */
export function getPlatformByUrl(url) {
  try {
    const hostname = new URL(url).hostname;

    for (const [platformId, platform] of Object.entries(EXTENSION_CONFIG.platforms)) {
      if (!platform.enabled) continue;

      if (platform.domains.some((domain) => matchesDomain(hostname, domain))) {
        // SAFETY: id is added last so it always overrides any platform.id (if accidentally added).
        return { ...platform, id: platformId };
      }
    }

    return null;
  } catch (error) {
    // Non-fatal: if url cannot be parsed, we just treat it as unsupported.
    if (EXTENSION_CONFIG.debug.enabled) {
      // eslint-disable-next-line no-console
      console.error('Error parsing URL in getPlatformByUrl:', error);
    }
    return null;
  }
}

/**
 * Get all enabled platforms.
 * @returns {PlatformDescriptor[]} Array of enabled platform configs with id.
 */
export function getEnabledPlatforms() {
  return Object.entries(EXTENSION_CONFIG.platforms)
    .filter(([, platform]) => platform.enabled)
    .map(([id, platform]) => {
      // id is added last so it always overrides any platform.id (if accidentally added).
      return { ...platform, id };
    });
}


