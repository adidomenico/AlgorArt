import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import jsdoc from 'eslint-plugin-jsdoc'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'coverage/',
      'src/contracts/', // generated typed clients (linked from contract artifacts)
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      // Classic React 18 hooks rules. The newer react-hooks "compiler" rules
      // (immutability, purity, set-state-in-render, ...) are skipped because
      // this project does not use the React Compiler.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // PropTypes are redundant when components are fully typed with TypeScript.
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off', // not needed with the new JSX transform
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // JSDoc rules, scoped to exported/public declarations so we don't have to
  // document every internal helper.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
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
  // Import rules: duplicates + import ordering.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    plugins: { import: importPlugin },
    rules: {
      // Resolution-based rules (no-unresolved, named, namespace, default,
      // export) are skipped: `tsc --noEmit` already validates module
      // resolution, and the default `eslint-import-resolver-node` cannot
      // read `exports`-only packages (e.g. vite, typescript-eslint).
      'import/no-duplicates': 'error',
      'import/no-named-as-default': 'error',
      'import/no-named-as-default-member': 'error',
      'import/order': [
        'error',
        {
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },
  // Test files get Vitest globals.
  {
    files: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },
  prettier,
)
