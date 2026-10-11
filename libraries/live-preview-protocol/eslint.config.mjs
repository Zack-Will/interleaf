import js from '@eslint/js'
import globals from 'globals'
import prettier from 'eslint-config-prettier/flat'

export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
    rules: {
      'prefer-const': 'error',
      'no-var': 'error',
      'no-unreachable': 'error',
      'no-console': 'error',
    },
  },
  prettier,
]
