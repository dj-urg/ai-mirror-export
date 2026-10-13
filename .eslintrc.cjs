module.exports = {
  env: { browser: true, es2024: true, webextensions: true, node: true },
  parserOptions: { ecmaVersion: 2024, sourceType: 'module' },
  globals: { browser: 'readonly', chrome: 'readonly' },
  rules: {
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-undef': 'error',
    'no-console': 'off',
    'no-implicit-globals': 'error',
    'eqeqeq': ['error', 'smart'],
    'prefer-const': 'warn',
    'no-var': 'error'
  },
  ignorePatterns: ['node_modules/', 'web-ext-artifacts/', 'venv/', 'testing/data/', 'submission.zip']
};
