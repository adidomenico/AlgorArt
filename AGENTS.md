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
  [`conventions.md`](docs/conventions.md) (lint/format/tsconfig rules),
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
- Don't create or switch branches or worktrees without explicit approval.
- The contract is the source of truth; the indexer is only a read model.
- **Confirm assumptions against real documentation.** Algorand behavior (box MBR,
  app lifecycle, indexer retention, transaction semantics, inner-txn fees) changes
  over time and is easy to misremember. Do not assert how the chain works from
  memory — check the official Algorand docs (see [References](#references)) before
  writing docs or code that depends on a protocol detail, and cite the source in
  the docs. When the docs are ambiguous, test on LocalNet rather than guessing.
- When you edit any Markdown file, lint it with the command in
  [Commands](#commands).

## Coding behaviour

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** these guidelines bias toward caution over speed. For trivial tasks, use judgement.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" -> "Write tests for invalid inputs, then make them pass."
- "Fix the bug" -> "Write a test that reproduces it, then make it pass."
- "Refactor X" -> "Ensure tests pass before and after."

For multi-step tasks, state a brief plan:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## Conventions

- **Generated files are gitignored.** `smart_contracts/artifacts/` (compiled TEAL, specs,
  `*Client.ts`) and the frontend's linked clients are build outputs — never edit or commit
  them. Rebuild instead.
- **Never commit secrets.** `.env` files are gitignored; mnemonics/API keys never go in code.
- **Lint, format, and compiler rules** (ESLint, Prettier, and `tsconfig.json` options)
  are documented in [`docs/conventions.md`](docs/conventions.md).
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

## Testing

- Contracts: simulator tests for full behavioral coverage (every method × every branch).
- Frontend: Vitest, with line coverage ≥ 90% on components and utils.
- Add or update tests in the same change set as the code they cover.

## Definition of done

Before marking work complete, run the checks from [Commands](#commands) in order —
format, lint, check-types, then the relevant test suite — and fix everything until
green. Don't skip a step because the change "looks small."

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
