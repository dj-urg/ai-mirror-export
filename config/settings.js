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
  version: '3.0.0',
  description:
    'Export conversations from ChatGPT, Claude, Copilot, Microsoft 365 Copilot, Perplexity, Grok, DeepSeek, Mistral and Google Search AI Overview to CSV. All processing happens locally in your browser.',

  // Supported platforms
  // IMPORTANT: Platform objects must NOT contain an 'id' property.
  // The 'id' is always derived from the object key by getPlatformByUrl().
  platforms: {
    chatgpt: {
      name: 'ChatGPT',
      domains: ['chatgpt.com', 'chat.openai.com'],
      enabled: true
    },
    claude: {
      name: 'Claude',
      domains: ['claude.ai'],
      enabled: true
    },
    copilot: {
      name: 'Copilot',
      domains: ['copilot.microsoft.com', 'copilotstudio.microsoft.com'],
      enabled: true
    },
    perplexity: {
      name: 'Perplexity',
      domains: ['www.perplexity.ai'],
      enabled: true
    },
    grok: {
      name: 'Grok',
      domains: ['grok.com'],
      enabled: true
    },
    deepseek: {
      name: 'DeepSeek',
      domains: ['chat.deepseek.com'],
      enabled: true
    },
    mistral: {
      name: 'Mistral',
      domains: ['chat.mistral.ai'],
      enabled: true
    },
    m365_copilot: {
      name: 'Microsoft 365 Copilot',
      domains: ['m365.cloud.microsoft'],
      enabled: true
    },
    google_search: {
      name: 'Google AI Overview',
      // Exactly the hosts in manifest.json. `www.` is deliberate: the
      // content script only runs on www.google.<tld>/search*, so the toolbar
      // must not light up on mail./docs./drive.google.com.
      domains: [
        'www.google.com', 'www.google.be', 'www.google.nl', 'www.google.fr', 'www.google.de',
        'www.google.co.uk', 'www.google.es', 'www.google.it', 'www.google.ca', 'www.google.com.au'
      ],
      enabled: true
    }
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
 */

/**
 * Check if a hostname matches a domain (exact or subdomain). Every entry in
 * EXTENSION_CONFIG.platforms[].domains must correspond to a host in
 * manifest.json's host_permissions / content_scripts matches, so that the
 * popup, the toolbar icon and the background's sender check agree with
 * where the content scripts actually run.
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
      console.error('Error parsing URL in getPlatformByUrl:', error);
    }
    return null;
  }
}
