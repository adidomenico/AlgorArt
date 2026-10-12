import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import jsdoc from 'eslint-plugin-jsdoc'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: ['node_modules/', 'dist/'],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
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
  // Import rules: duplicates and named-default safety. Ordering is handled by
  // `prettier-plugin-organize-imports` so the two tools never disagree.
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    plugins: { import: importPlugin },
    rules: {
      // Resolution-based rules (no-unresolved, named, namespace, default,
      // export) are skipped: `tsc --noEmit` already validates module
      // resolution, and the default `eslint-import-resolver-node` cannot
      // read `exports`-only packages.
      'import/no-duplicates': 'error',
      'import/no-named-as-default': 'error',
      'import/no-named-as-default-member': 'error',
    },
  },
  prettier,
)
