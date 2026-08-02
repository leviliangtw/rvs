import js from '@eslint/js'
import globals from 'globals'

export default [
  js.configs.recommended,

  // Shared rules: allow conventional "intentionally ignored" patterns
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Node.js signaling server (CommonJS)
  {
    files: ['server.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // Chrome extension content/popup/page scripts
  {
    files: ['extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
      },
    },
  },

  // Service worker: background.js and tab-session.js share one scope via
  // importScripts (background.js loads config.js and tab-session.js).
  {
    files: ['extension/background.js', 'extension/tab-session.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, WS_SERVER_URL: 'readonly' },
    },
  },
  // background.js additionally sees createTabSession as a cross-file global
  // (declared in its own block so ESLint doesn't treat tab-session.js's own
  // definition as redeclaring a "global"). tab-session.js needs no such
  // entry for updateIcon — background.js passes it in explicitly as a
  // parameter now, not a bare global.
  {
    files: ['extension/background.js'],
    languageOptions: {
      globals: { createTabSession: 'readonly' },
    },
  },
]
