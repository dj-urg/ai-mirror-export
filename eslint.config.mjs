// ESLint flat config (v9+). Behaviour-preserving translation of the former
// .eslintrc.cjs: same rule set, same ignore patterns, same global environment.
// `globals` is already present as a transitive dependency of ESLint itself.
//
// A handful of cross-file identifiers below are not imported — they are
// provided by sibling scripts loaded together in the same content-script,
// background, or popup context via manifest.json/popup.html. Declaring them
// as readonly globals matches runtime reality and preserves lint behaviour
// (the old config would also have reported them as `no-undef` otherwise).

import globals from 'globals';

const sharedExtensionGlobals = {
  browser: 'readonly',
  chrome: 'readonly',
  // From shared/message-security.js, loaded alongside each inject.js/content.js
  MessageSecurity: 'readonly',
  // From shared/errors.js
  ERROR_TYPES: 'readonly',
  PLATFORM_TROUBLESHOOTING: 'readonly',
  formatAuthFailureCopy: 'readonly',
  sanitizeErrorMessage: 'readonly',
  // From shared/logger.js
  logDebug: 'readonly',
  logError: 'readonly',
  // From config/settings.js
  getPlatformByUrl: 'readonly',
  // Loaded by DOM-based tests that pull extractor/platform code via <script>
  detectPlatform: 'readonly',
  extractTextFromContent: 'readonly',
  flattenMetadata: 'readonly'
};

export default [
  {
    ignores: [
      'node_modules/**',
      'web-ext-artifacts/**',
      'venv/**',
      'testing/data/**',
      'submission.zip'
    ]
  },
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.webextensions,
        ...sharedExtensionGlobals
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-console': 'off',
      'no-implicit-globals': 'error',
      'eqeqeq': ['error', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error'
    }
  },
  {
    // CommonJS test helpers predate the ES-module migration.
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs'
    }
  }
];
