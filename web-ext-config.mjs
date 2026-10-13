// ESM form (`export default`) is required because web-ext's config loader
// dynamic-imports .cjs files and Node emits a literal "module.exports" named
// export from `module.exports = …`, which web-ext then rejects as a non-
// camelCase config option. .mjs with `export default` sidesteps that path.
export default {
  ignoreFiles: [
    // Python / data / tests
    'venv', 'venv/**',
    'data', 'data/**',
    'testing', 'testing/**',
    'test', 'test/**',
    'tests', 'tests/**',
    '__pycache__', '__pycache__/**',
    '*.py',
    '*.pyc',

    // Dev tooling and preview harness (never ships to AMO)
    'dev', 'dev/**',
    'docs', 'docs/**',
    'node_modules', 'node_modules/**',
    'web-ext-artifacts', 'web-ext-artifacts/**',
    'package.json',
    'package-lock.json',
    'yarn.lock',
    '.eslintrc.cjs',
    '.eslintrc.js',
    '.eslintrc.json',
    'eslint.config.mjs',
    'eslint.config.js',
    'eslint.config.cjs',
    'CITATION.cff',
    'web-ext-config.cjs',
    'web-ext-config.mjs',
    'web-ext-config.js',

    // Version control + editors + CI
    '.git', '.git/**',
    '.github', '.github/**',
    '.gitignore',
    '.vscode', '.vscode/**',
    '.kiro', '.kiro/**',
    '.claude', '.claude/**',
    '.playwright-mcp', '.playwright-mcp/**',

    // OS cruft
    '.DS_Store',
    'Thumbs.db',

    // Local exports, logs, secrets and build output. These are gitignored,
    // but web-ext packages from disk, so anything present here would ship.
    '*.csv',
    '*.log', '*.tmp', '*.temp', '*.bak', '*.swp',
    '.env', '.env.*', 'secrets.json', '*.key', '*.pem', '*.cert', '*.har',
    'coverage', 'coverage/**', 'dist', 'dist/**', 'build', 'build/**',
    '.idea', '.idea/**',

    // Build artifacts + miscellany
    '*.zip',
    '*.xpi',
    '*.md',
    'updates.json',
    'submission.zip',
    'nodes.md',
  ],
};
