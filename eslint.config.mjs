// ESLint flat config (v9+).
//
// Globals are scoped per file. Only files that genuinely receive identifiers
// from a sibling script loaded in the same page get them declared; everything
// else (background.js, extractors, utils/, config/, dev/) is strictly
// import-checked, so a missing `import` fails lint instead of surfacing as a
// ReferenceError in Firefox (the review found two of those).

import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      'web-ext-artifacts/**',
      'venv/**',
      'testing/data/**',
      'submission.zip',
      // Legacy, untracked, hand-run scripts kept locally for archaeology.
      // Not part of `npm test`, not in git, never shipped.
      'testing/tests/*.cjs',
      'testing/tests/validate_*.js',
      'testing/tests/check_*.js',
      'testing/tests/local_*.js'
    ]
  },
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.webextensions
      }
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-undef': 'error',
      'no-console': 'off',
      'no-implicit-globals': 'error',
      'eqeqeq': ['error', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error'
    }
  },
  {
    // Content and inject scripts are classic scripts. manifest.json loads
    // shared/message-security.js in the same world ahead of each of them,
    // which defines window.MessageSecurity.
    files: ['platforms/**/inject.js', 'platforms/**/content.js', 'shared/message-security.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        MessageSecurity: 'readonly'
      }
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
