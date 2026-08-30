# AGENTS.md

Guidance for AI coding agents (and contributors) working in this repository.

## What this is

AlgorArt is a non-custodial crowdfunding dApp on Algorand. The v2 implementation is an
AlgoKit workspace; the old v1 (ASP.NET Core, server-side wallets) lives in the sibling
`AlgorArt-v1/` folder and is reference-only. This repo covers v2 only.

## Layout

- `projects/contracts/` — AlgoKit contract project (Algorand TypeScript → AVM)
  - `smart_contracts/campaign/contract.algo.ts` — the `Campaign` escrow app
    (`create`, `pledge`, `claim`, `refund`)
  - `smart_contracts/artifacts/` — **generated** (compiled TEAL, ARC-32/56 specs, clients)
- `projects/frontend/` — React + Vite + TypeScript dApp
- `docs/` — human-readable technical docs (contract internals, design decisions)
- `README.md` — the v2 specification (contract design, roadmap, testing strategy)

## Commands

Run from the repo root unless noted.

```bash
algokit project bootstrap all    # install deps for contracts + frontend
algokit localnet start           # start algod + indexer (Docker)

cd projects/contracts
npm run build                    # compile contracts + generate typed clients
npm run check-types              # tsc --noEmit

cd ../frontend
npm run dev                      # regenerates app clients then runs Vite
```

## Conventions

- **Generated files are gitignored.** `smart_contracts/artifacts/` (compiled TEAL, specs,
  `*Client.ts`) and the frontend's linked clients are build outputs — never edit or commit
  them. Rebuild instead.
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
- **The contract is the source of truth.** The indexer is only a read model; no backend
  holds funds or keys.
- **Keep docs aligned.** Whenever a change affects behavior, structure, commands, or
  conventions, update the relevant docs in the same change set:
  - `docs/` for technical details and design decisions
  - `README.md` for spec-level behavior, roadmap status, and getting-started steps
  - `AGENTS.md` (this file) for commands, conventions, and agent-facing guidance
  If the change doesn't affect these, no doc update is needed.

## Testing

- Contracts: simulator tests for full behavioral coverage (every method × every branch).
- Frontend: Vitest, with line coverage ≥ 90% on components and utils.

## Commits & pull requests

- **Always propose a commit message** when wrapping up a set of changes or when the user
  asks to commit. Do not commit or push automatically unless asked.
- Follow **Conventional Commits**: `<type>(<scope>): <description>`
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`
  - Scopes: `contracts`, `frontend`, `repo` (workspace/docs/CI). Omit the scope when a
    change spans everything.
  - Description is imperative and ≤ 72 chars, e.g. `feat(contracts): add pledge escrow contract`.
  - No body unless needed; when present, explain the "why" as a short bullet list.
- **Pull requests** use the template in `.github/pull_request_template.md`.

## Roadmap

Phase 0 (setup) done → Phase 1 (contract + tests + localnet) → Phase 2 (frontend) →
Phase 3 (TestNet demo) → Phase 4 (polish). See `README.md`.
