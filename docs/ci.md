# CI

Design notes for the GitHub Actions setup. Implemented so far: the pure-Node
workflows ([`lint-format-type-check`](.github/workflows/lint-format-type-check.yml)
and [`markdown-lint`](.github/workflows/markdown-lint.yml)). The rest is planned —
this documents the reasoning behind the split.

## Principles

- **Split by prerequisites.** A lint/format/type-check job needs only Node.js,
  so it should never wait on (or install) the heavier toolchain. Splitting keeps
  feedback fast and failures attributable to the right lane.
- **Parallel lanes per project.** `contracts` and `frontend` are independent npm
  projects; run them side by side, not sequentially.
- **CI calls the per-project npm scripts directly** (`npm run lint`, …), not
  `algokit project run`. The algokit wrapper is a local convenience and runs
  projects sequentially.

## What each workflow needs

| Workflow | Node.js | AlgoKit CLI | Docker |
| --- | --- | --- | --- |
| `lint-format-type-check` — lint, format, type-check | ✅ | — | — |
| `markdown-lint` — markdownlint | ✅ | — | — |
| `build` — compile contracts, build frontend | ✅ | ✅ | — |
| `test` — contract simulator + frontend unit | ✅ | ✅ (compile contracts) | — |
| localnet integration — deploy + exercise | ✅ | ✅ | ✅ (algod + indexer) |

Key point: **`lint-format-type-check` and `markdown-lint` are pure Node**.
`eslint`, `prettier`, `tsc`, and `markdownlint-cli2` need nothing else — no
Docker, no AlgoKit, no build.

## Workflow: lint-format-type-check

Implemented at `.github/workflows/lint-format-type-check.yml`. A matrix over
`[contracts, frontend]`, with each lane running lint, format, and type-check.
Node is cached (`cache: npm` + `cache-dependency-path`), and `fail-fast` is off
so one project's failure doesn't cancel the other lane. `npm run format` runs
Prettier in `--check` mode, so it fails on style drift without modifying files —
the right behavior for CI.

## Workflow: markdown-lint (separate file)

Implemented at `.github/workflows/markdown-lint.yml`. Markdown linting gets its
**own workflow file**, because triggers live at the workflow level — a job
cannot have a different trigger than its workflow. Splitting it allows a
`paths:` filter so the markdown job only runs when docs (or the markdownlint
config) change.

This also gives markdown its own status check, so a docs failure isn't buried
under the per-project matrix. The lint command itself still checks *all*
`*.md` files — cheap, and the rules are repo-wide. (The job is ~30s, so it
could just as well run on every push; the `paths:` filter is about clean
semantics, not speed.)

## Workflow: build

Compiling the contracts (`algokit compile`) and linking the frontend clients
(`algokit project link`) require the **AlgoKit CLI** (Python). Node alone is not
enough. This workflow installs Node + AlgoKit, then runs `npm run build` in each
project. No Docker required — compilation is offline.

## Workflow: test

Testing taxonomy — the two parts have *different* shapes:

| Part | Test layers | Why |
| --- | --- | --- |
| **Contracts** | Simulator tests (`contract.spec.ts`) only | Contract code compiles to AVM bytecode and only executes inside the AVM. There is no way to unit-test a method in isolation — the simulator *is* the contract's test layer. (Pure helper modules extracted from the contract, if any, could get plain Vitest unit tests.) |
| **Frontend** | Unit (utils) + component (React + Testing Library) + optional E2E | Ordinary TypeScript/React, so the full pyramid applies. |

Note: "spec" in `*.spec.ts` is a **filename convention** (the generator names
test files `.spec.ts`), not a test *type*. Don't read "spec tests vs unit tests"
as two contract layers — the simulator suite is the whole pyramid for contracts.

1. **Contract simulator tests** (`contract.spec.ts`) — full behavioral coverage
   (every method × every branch). Runs in-process under Node; no Docker.
2. **Frontend unit/component tests** — **Vitest** over components and utils,
   line coverage ≥ 90%.

Both are planned but **not written yet** (Phase 1 tests, Phase 2 frontend).
Once they exist, the `test` workflow installs Node + AlgoKit, compiles the
contracts, and runs both suites.

> The frontend `.algokit.toml` references `npm run test`, but the frontend
> `package.json` has no `test` script yet — to be added when Phase 2 tests land.

## Caching — avoid redoing work every run

No custom Docker image is built or pulled for `lint-format-type-check`,
`markdown-lint`, `build`, or `test`. Tooling is installed on the runner and
**cached**, which is simpler than maintaining a CI image:

- **Node** — `actions/setup-node@v4` with `cache: npm` and
  `cache-dependency-path` pointing at the project's `package-lock.json`. This
  caches `node_modules`, so `npm ci` is ~seconds on cache hits.
- **AlgoKit (Python)** — `actions/cache@v4` over `~/.local/pipx` keyed by the
  AlgoKit version.

The only Docker in CI is the **prebuilt** algod/indexer sandbox images, pulled
only by the localnet integration job (not the hot path). If a custom CI image
ever becomes worth it (runner install time is the trigger), publish it once to
GHCR and rebuild only when its `Dockerfile` changes — but at this scale,
install-on-runner + cache is the right default.

## Localnet integration (later)

Deploying to a local sandbox and exercising the flow needs `algokit localnet
start` (algod + indexer in Docker). This is Phase 1's "deploy to localnet" and
Phase 3's TestNet demo — a separate, heavier job, not part of
`lint-format-type-check`.
