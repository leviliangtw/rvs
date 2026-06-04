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

  // Service worker: importScripts globals + WS_SERVER_URL from config.js
  {
    files: ['extension/background.js'],
    languageOptions: {
      globals: { ...globals.serviceworker, WS_SERVER_URL: 'readonly' },
    },
  },
]
