# AGENTS.md

Guidance for AI coding agents (and contributors) working in this repository.

## What this is

AlgorArt is a non-custodial crowdfunding dApp on Algorand, built as an AlgoKit
workspace: an Algorand TypeScript smart contract plus a React + Vite frontend.

## Layout

- `projects/contracts/` — AlgoKit contract project (Algorand TypeScript → AVM)
  - `smart_contracts/campaign/contract.algo.ts` — the `Campaign` escrow app
    (`create`, `fund`, `attachClaimAsa`, `pledge`, `claim`, `refund`,
    `cancelPledge`, `closeOut`, `delete`); its escrow holds only the creator's
    deposit
  - `smart_contracts/claimsvault/contract.algo.ts` — the `ClaimsVault`: pooled
    refund escrow + per-campaign Claim ASA issuer (`issueClaimAsa`, `seedSupply`,
    `payBack`, `payClaim`, `settle`, `refund`, `sweepClaimAsa`, `destroyClaimAsa`)
  - `smart_contracts/factory/contract.algo.ts` — the on-chain `Factory`
    registry (owner-configured approval hash, `register`/`unregister`)
  - `smart_contracts/artifacts/` — **generated** (compiled TEAL, ARC-32/56 specs, clients)
- `projects/frontend/` — React + Vite + TypeScript dApp
- [`docs/`](docs/) — technical docs: [`campaign.md`](docs/campaign.md)
  (internals), [`claim-asa-redesign.md`](docs/claim-asa-redesign.md)
  (design rationale), [`testing.md`](docs/testing.md),
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
  - ABI payment arguments are `gtxn.PaymentTxn`; asset-transfer arguments are
    `gtxn.AssetTransferTxn`; the escrow address is
    `Global.currentApplicationAddress`.
  - An asset id is stored in global state as a plain `uint64` (`GlobalState<uint64>`)
    and wrapped with `Asset(...)` where a reference type is needed.
  - Inner asset transactions (`itxn.assetTransfer`/`itxn.assetConfig`) and
    `op.AssetHolding.assetBalance` require the asset to be in the **outer call's
    foreign assets** — the frontend passes `assetReferences: [assetId]` (grouped
    gtxn transfers pool their own assets, so `refund(axfer)` needs none).
  - Destroy an ASA with `itxn.assetConfig({ configAsset, fee: Uint64(0) })` (no
    other fields) — only valid when the creator account holds the full supply.
  - **Box access needs declared references on the outer txn** (AVM): inner app
    calls that read/write another app's BoxMaps fail with "invalid Box
    reference" unless `boxReferences` lists the box names. Keep BoxMap keys
    derivable from ABI args so `populateAppCallResources` can fill them; names
    derived from inner-created ids (e.g. a created asset id) can never be
    declared — avoid that keying.
  - Inner app calls use raw ARC-4 selectors (the emitted signatures flatten
    `Application`→`uint64`, `Account`→`address`) — compute them from the emitted
    ARC-56 and keep them in sync with a test.
  - A zero-amount asset transfer only opts a receiver in when sender == receiver
    (self-opt-in); one app cannot opt another account in on its behalf.
  - Reading a foreign app's global state works via
    `op.AppGlobal.getExUint64/getExBytes(app, key)`; foreign **box** reads have
    no opcode — derive lookups from caller-supplied ids verified against local
    mappings instead.
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

- **Never commit or push automatically** unless asked; always propose a commit message first.
- Follow **Conventional Commits**: `<type>(<scope>): <description>`
  - Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`, `style`
  - Scopes: `contracts`, `frontend`, `repo` (workspace/docs/CI). Omit the scope when a
    change spans everything.
  - Description is imperative and ≤ 72 chars.
  - No body unless needed; when present, explain the "why" as a short bullet list.
  - Example: `feat(contracts): add pledge escrow contract`.
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
