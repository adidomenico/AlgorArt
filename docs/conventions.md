# Conventions

Lint, format, and TypeScript compiler configuration. Agents can also read
`eslint.config.mjs`, `tsconfig.json`, and `.prettierrc.json` directly; this page
documents the rules and the reasoning behind them.

- **Lint & format are required.** ESLint (flat config, `typescript-eslint`,
  `eslint-plugin-jsdoc`, `eslint-plugin-import`) and Prettier run per project via
  `npm run lint` / `npm run format`. Keep sources lint- and format-clean; configs are
  shared from the repo-root `.prettierrc.json`.
- **Type-aware linting is on.** `typescript-eslint` uses the `strictTypeChecked`
  preset via `projectService`, so rules like `no-floating-promises`,
  `no-misused-promises`, `no-unnecessary-condition`, and the `no-unsafe-*` family run
  with full type information. The `no-unsafe-*` rules are relaxed in test files (Vitest
  mocks return `any`, and the simulator vendors its own `algorand-typescript` copy, so
  its enums are nominally distinct from the project's). Config files outside any
  `tsconfig.json` are listed in
  `allowDefaultProject`.
- **Cheap safety rails.** `eqeqeq` (always use `===`/`!==`) and
  `@typescript-eslint/no-non-null-assertion` (no `!` assertions) are both at `error`
  severity.
- **`noImplicitOverride` is on.** `tsconfig.json` in both projects enables
  `noImplicitOverride`, so any member that overrides a base-class member must be marked
   with the `override` keyword (for example, `override render()` in `ErrorBoundary`).
- **`noUnusedLocals`/`noUnusedParameters` are on.** `tsconfig.json` in both projects
  enables them, so unused variables/parameters are caught by `tsc --noEmit`, not just
  ESLint. Generated client files are exempt: contracts exclude
  `smart_contracts/artifacts` from `tsc`, and the frontend prepends `// @ts-nocheck` to
  the linked `src/contracts/*.ts` files via `scripts/ts-nocheck-generated.mjs` (wired
  into `generate:app-clients` and the CI link step).
- **`verbatimModuleSyntax` is on (contracts).** The contracts `tsconfig.json` enables
  it, so type-only imports must be written `import type` and the compiler no longer
  elides them silently. The frontend omits it - Vite (rolldown) does not elide
  type-only imports in the generated client, which imports them as value imports and
  would fail the bundle step. The frontend instead relies on
  `@typescript-eslint/consistent-type-imports`.
- **`noUncheckedIndexedAccess` is on.** `tsconfig.json` in both projects enables it,
  so `arr[i]` and record access yield `T | undefined` and require explicit guards,
  defaults, or optional chaining before use.
- **`exactOptionalPropertyTypes` is on.** `tsconfig.json` in both projects enables
  it, so an optional property means "may be absent" rather than "`T | undefined`".
  Fields that can genuinely be `undefined` are declared `T | undefined` explicitly.
- **Imports are checked.** `eslint-plugin-import` enforces `no-duplicates`,
  `no-named-as-default`, and `no-named-as-default-member` at `error` severity.
  Resolution-based rules (`no-unresolved` etc.) are intentionally off - `tsc --noEmit`
  already validates module resolution, and the default `eslint-import-resolver-node`
  cannot read `exports`-only packages. Import **ordering** is owned by
  `prettier-plugin-organize-imports` (enabled in the shared `.prettierrc.json`), not by
  an ESLint rule, so the formatter and linter never disagree.
- **Tailwind classes are linted (frontend only).** `eslint-plugin-tailwindcss` runs on
  `**/*.tsx` with `cssConfigPath` pointing at the v4 stylesheet
  (`src/styles/App.css`), so custom `@theme` colors resolve instead of reading as
  typos. Enabled rules: `classnames-order`, `no-contradicting-classname`,
  `no-custom-classname`, `enforces-shorthand`, `no-unnecessary-arbitrary-value`,
  `enforces-canonical-classname`, `enforces-negative-arbitrary-values`,
  `important-modifier-suffix`
  (all `error`, all autofixable via `npm run lint:fix`). Class **ordering** lives
  here, not in Prettier - the official `prettier-plugin-tailwindcss` conflicts with
  `organize-imports`/`jsdoc` (shared parser hooks) and reflows unrelated comments,
  so it is deliberately not installed.
- **Sizes live in the theme, in rem.** Repeated values become `@theme` tokens
  (`--text-badge`, `--tracking-label`, `--width-modal`, ...) instead of arbitrary
  values; sizing uses `rem` so it follows the user's font-size settings, with `px`
  reserved for deliberate fixed geometry (1px hairlines) and `em` where sizing must
  stay relative to the element. `no-unnecessary-arbitrary-value` enforces the
  convertible cases; the remaining arbitrary values (`grid-cols-[repeat(...)]`,
  `content-['']`, `font-[inherit]`) are one-offs with no scale equivalent and stay.
  `no-arbitrary-value` stays off on purpose: it has no whitelist and would ban those
  legitimate cases.
- **JSDoc is required on public/exported declarations.** The jsdoc plugin runs the
  `flat/recommended-typescript-error` preset (all rules at `error` severity), with
  `require-jsdoc` and `require-returns` scoped via `publicOnly` so internal helpers are
  exempt. Document exported functions, classes, and interfaces; keep `@param`/`@returns`
  descriptions in the same style as the surrounding code.
- **JSDoc is formatted by Prettier.** `prettier-plugin-jsdoc` is enabled in the shared
  repo-root `.prettierrc.json`. It inserts one blank line between the description and
  the first tag, which `jsdoc/tag-lines` is configured to match (`startLines: 1`), so
  `npm run format` and `npm run lint` agree.
- **Markdown is linted too.** Run `npx --yes markdownlint-cli2@0.23.2` (from the repo
  root) to lint every `*.md` file; add `--fix` to autofix. Rules, globs, and ignores
  all live in a single `.markdownlint-cli2.jsonc`, shared with the VS Code extension.
  The version is pinned in the command (no root `package.json` needed).
