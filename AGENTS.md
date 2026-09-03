# AGENTS.md

Guidance for AI coding agents (and contributors) working in this repository.

## What this is

AlgorArt is a non-custodial crowdfunding dApp on Algorand, built as an AlgoKit
workspace: an Algorand TypeScript smart contract plus a React + Vite frontend.

## Layout

- `projects/contracts/` — AlgoKit contract project (Algorand TypeScript → AVM)
  - `smart_contracts/campaign/contract.algo.ts` — the `Campaign` escrow app
    (`create`, `pledge`, `claim`, `refund`)
  - `smart_contracts/artifacts/` — **generated** (compiled TEAL, ARC-32/56 specs, clients)
- `projects/frontend/` — React + Vite + TypeScript dApp
- [`docs/`](docs/) — technical docs: [`campaign.md`](docs/campaign.md)
  (internals), [`testing.md`](docs/testing.md),
  [`frontend.md`](docs/frontend.md), [`ci.md`](docs/ci.md),
  [`roadmap.md`](docs/roadmap.md) (checklist), [`design.md`](docs/design.md) (product plan)
- [`README.md`](README.md) — the project specification (contract design, roadmap, testing strategy)

## Commands

Run from the repo root unless noted.

```bash
algokit project bootstrap all    # install deps for contracts + frontend
algokit localnet start           # start algod + indexer (Docker)

npx --yes markdownlint-cli2@0.23.2        # markdownlint across all docs (add --fix to autofix)

cd projects/contracts
npm run build                    # compile contracts + generate typed clients
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint (also: npm run lint:fix)
npm run format                   # Prettier check (also: npm run format:fix)

cd ../frontend
npm run dev                      # regenerates app clients then runs Vite
npm run check-types              # tsc --noEmit
npm run lint                     # ESLint (+ react/react-hooks plugins)
npm run format                   # Prettier check
```

Or from the repo root: `algokit project run lint` / `algokit project run format` /
`algokit project run check-types` applies to every project in the workspace.

## How to work

- Read [`README.md`](README.md) and the relevant file under [`docs/`](docs/) **before**
  changing behavior.
- Implement the smallest change that satisfies the request; no unrequested refactors
  or speculative extensibility.
- Add or update tests for any code you change, even when not asked.
- Don't create or switch branches or worktrees without explicit approval.
- If it's unclear how to verify a change, ask.
- The contract is the source of truth; the indexer is only a read model.
- **Confirm assumptions against real documentation.** Algorand behavior (box MBR,
  app lifecycle, indexer retention, transaction semantics, inner-txn fees) changes
  over time and is easy to misremember. Do not assert how the chain works from
  memory — check the official Algorand docs (see [References](#references)) before
  writing docs or code that depends on a protocol detail, and cite the source in
  the docs. When the docs are ambiguous, test on LocalNet rather than guessing.
- When you edit any Markdown file, run `npx --yes markdownlint-cli2@0.23.2`
  (from the repo root) to lint it.

## Conventions

- **Generated files are gitignored.** `smart_contracts/artifacts/` (compiled TEAL, specs,
  `*Client.ts`) and the frontend's linked clients are build outputs — never edit or commit
  them. Rebuild instead.
- **Lint & format are required.** ESLint (flat config, `typescript-eslint`,
  `eslint-plugin-jsdoc`, `eslint-plugin-import`) and Prettier run per project via
  `npm run lint` / `npm run format`. Keep sources lint- and format-clean; configs are
  shared from the repo-root `.prettierrc.json`.
- **Type-aware linting is on.** `typescript-eslint` uses the `strictTypeChecked`
  preset via `projectService`, so rules like `no-floating-promises`,
  `no-misused-promises`, `no-unnecessary-condition`, and the `no-unsafe-*` family run
  with full type information. The `no-unsafe-*` rules are relaxed in test files (Vitest
  mocks return `any`). Config files outside any `tsconfig.json` are listed in
  `allowDefaultProject`.
- **Cheap safety rails.** `eqeqeq` (always use `===`/`!==`) and
  `@typescript-eslint/no-non-null-assertion` (no `!` assertions) are both at `error`
  severity.
- **`noImplicitOverride` is on.** `tsconfig.json` in both projects enables
  `noImplicitOverride`, so any member that overrides a base-class member must be marked
  with the `override` keyword (e.g. `override render()` in `ErrorBoundary`).
- **`noUnusedLocals`/`noUnusedParameters` are on.** `tsconfig.json` in both projects
  enables them, so unused variables/parameters are caught by `tsc --noEmit`, not just
  ESLint. Generated client files are exempt: contracts exclude
  `smart_contracts/artifacts` from `tsc`, and the frontend prepends `// @ts-nocheck` to
  the linked `src/contracts/*.ts` files via `scripts/ts-nocheck-generated.mjs` (wired
  into `generate:app-clients` and the CI link step).
- **`verbatimModuleSyntax` is on (contracts).** The contracts `tsconfig.json` enables
  it, so type-only imports must be written `import type` and the compiler no longer
  elides them silently. The frontend omits it — Vite (rolldown) does not elide
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
  Resolution-based rules (`no-unresolved` etc.) are intentionally off — `tsc --noEmit`
  already validates module resolution, and the default `eslint-import-resolver-node`
  cannot read `exports`-only packages. Import **ordering** is owned by
  `prettier-plugin-organize-imports` (enabled in the shared `.prettierrc.json`), not by
  an ESLint rule, so the formatter and linter never disagree.
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
- **Never commit secrets.** `.env` files are gitignored; mnemonics/API keys never go in code.
- **Algorand TypeScript gotchas** (contracts use `@algorandfoundation/algorand-typescript`):
  - `assert` must be imported explicitly — it is not a global.
  - `GlobalState`/`BoxMap` class properties require the options object
    (e.g. `BoxMap<Account, uint64>({ keyPrefix: 'p' })`).
  - Create-time methods use `@abimethod({ onCreate: 'require' })`.
  - Reading a `BoxMap` entry `.value` fails if the box is missing — use
    `.get({ default: 0 })` for first-write patterns.
  - ABI payment arguments are `gtxn.PaymentTxn`; the escrow address is
    `Global.currentApplicationAddress`.
- **Keep docs aligned.** Whenever a change affects behavior, structure, commands, or
  conventions, update the relevant docs in the same change set:
  - `docs/` for technical details and design decisions
  - `README.md` for spec-level behavior, roadmap status, and getting-started steps
  - `AGENTS.md` (this file) for commands, conventions, and agent-facing guidance
  If the change doesn't affect these, no doc update is needed.
- When updating any `*.md` file, run `npx --yes markdownlint-cli2@0.23.2` (from the
  repo root; add `--fix` to autofix) to keep it lint-clean.

## Testing

- Contracts: simulator tests for full behavioral coverage (every method × every branch).
- Frontend: Vitest, with line coverage ≥ 90% on components and utils.
- Add or update tests in the same change set as the code they cover.

## Definition of done

Before marking work complete, run these from `projects/contracts` and/or
`projects/frontend` (or `algokit project run …` from the repo root), in order:

1. `npm run format` (then `npm run format:fix` if it reports)
2. `npm run lint`
3. `npm run check-types`
4. The relevant test suite

Fix everything until green — don't skip a step because the change "looks small."

## Commits & pull requests

- **Always propose a commit message** when wrapping up a set of changes or when the user
  asks to commit. Do not commit or push automatically unless asked.
- Follow **Conventional Commits**: `<type>(<scope>): <description>`
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`
  - Scopes: `contracts`, `frontend`, `repo` (workspace/docs/CI). Omit the scope when a
    change spans everything.
  - Description is imperative and ≤ 72 chars, e.g. `feat(contracts): add pledge escrow contract`.
  - No body unless needed; when present, explain the "why" as a short bullet list.
- **Pull requests** use the template in [`.github/pull_request_template.md`](.github/pull_request_template.md).

## Roadmap

Work left to do is tracked as a checklist in [`docs/roadmap.md`](docs/roadmap.md),
organized by area (contract, frontend UX, content, TestNet, CI). Product design and
open questions live in [`docs/design.md`](docs/design.md). `README.md` carries only
the short status summary.

## References

Official Algorand docs — consult these (and cite them in `docs/`) instead of
working from memory on protocol details:

- [Applications](https://dev.algorand.co/concepts/smart-contracts/apps/) — app
  lifecycle, `DeleteApplication`, inner transactions.
- [Box Storage](https://dev.algorand.co/concepts/smart-contracts/storage/box/) —
  box MBR, box deletion, app-deletion caveats.
- [Inner Transactions](https://dev.algorand.co/concepts/smart-contracts/inner-txn/) —
  app-account payments and inner-txn fees.
- [Transaction Types](https://dev.algorand.co/concepts/transactions/types/) —
  payment `close`, application call transaction kinds.
- [Indexer REST API](https://dev.algorand.co/reference/rest-api/indexer/) —
  application `deleted` / `deleted-at-round`, `include-all`, box lookup.
- [Algorand TypeScript](https://dev.algorand.co/get-started/algokit/) — AlgoKit and
  `algorand-typescript` entry points.
