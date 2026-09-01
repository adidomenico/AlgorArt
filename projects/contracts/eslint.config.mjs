import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'
import jsdoc from 'eslint-plugin-jsdoc'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: ['node_modules/', 'dist/', 'coverage/', 'smart_contracts/artifacts/', '.algokit/'],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // JSDoc rules, scoped to exported/public declarations so we don't have to
  // document every internal helper.
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    plugins: { jsdoc },
    rules: {
      ...jsdoc.configs['flat/recommended-typescript-error'].rules,
      'jsdoc/require-jsdoc': ['error', { publicOnly: true }],
      'jsdoc/require-returns': ['error', { publicOnly: true }],
      // Match prettier-plugin-jsdoc, which puts one blank line between the
      // description and the first tag.
      'jsdoc/tag-lines': ['error', 'never', { startLines: 1 }],
    },
  },
  // Test files (simulator + integration) get Vitest globals.
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },
  prettier,
)
