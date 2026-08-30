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
| `test` — offline unit tests + coverage | ✅ | — | — |
| `build` — compile contracts, build frontend | ✅ | ✅ | — |
| `localnet` — deploy + exercise integration tests | ✅ | ✅ | ✅ (algod + indexer) |

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

## Workflow: test (implemented)

Testing taxonomy — the two parts have *different* shapes:

| Part | Test layers | Why |
| --- | --- | --- |
| **Contracts** | Offline AVM tests (`contract.algo.spec.ts`) only | Contract code compiles to AVM bytecode and only executes inside the AVM. There is no way to unit-test a method in isolation — the offline AVM runtime *is* the contract's test layer. (Pure helper modules extracted from the contract, if any, could get plain Vitest unit tests.) |
| **Frontend** | Unit (utils) + component (React + Testing Library) + optional E2E | Ordinary TypeScript/React, so the full pyramid applies. |

1. **Contract offline AVM tests** (`contract.algo.spec.ts`) — full behavioral coverage
   (every method × every branch). Runs in-process under Node; no Docker.
2. **Frontend unit/component tests** — **Vitest** over components and utils,
   line coverage ≥ 90%.

Implemented at `.github/workflows/test.yml`. A matrix over `[contracts]`
(frontend joins in Phase 2, once its `test` script exists) that runs
`npm run test:coverage` — the offline AVM tests plus the V8 coverage gate
(lines/branches/functions at 100%; see `docs/contracts/testing.md`).

This is **pure Node**: offline tests don't need the AlgoKit CLI, Docker, or a
compile step, because the `algorand-typescript-testing` transformer runs the
contract source directly under Node. That's why it's a separate, fast workflow
rather than being bundled with the heavier build/integration lanes.

The frontend's `test` script does not exist yet — to be added when Phase 2
tests land, at which point `frontend` joins the matrix.

> The frontend `.algokit.toml` references `npm run test`, but the frontend
> `package.json` has no `test` script yet — to be added when Phase 2 tests land.

## Caching — avoid redoing work every run

No custom Docker image is built or pulled for `lint-format-type-check`,
`markdown-lint`, `build`, or `test`. Tooling is installed on the runner and
**cached**, which is simpler than maintaining a CI image:

- **Node** — `actions/setup-node@v7` with `cache: npm` and
  `cache-dependency-path` pointing at the project's `package-lock.json`. This
  caches `node_modules`, so `npm ci` is ~seconds on cache hits.
- **AlgoKit (Python)** — installed fresh via `pipx` in the localnet job (not
  cached). The install is fast relative to the Docker container startup that
  dominates that job, and caching pipx correctly (venv *and* the `bin`
  symlinks) isn't worth the complexity.

The only Docker in CI is the **prebuilt** algod/indexer sandbox images, pulled
only by the localnet integration job (not the hot path). If a custom CI image
ever becomes worth it (runner install time is the trigger), publish it once to
GHCR and rebuild only when its `Dockerfile` changes — but at this scale,
install-on-runner + cache is the right default.

## Localnet integration (implemented)

Implemented at `.github/workflows/localnet.yml`. This is the one lane that
needs the full stack: **Docker** (algod + indexer via `algokit localnet start`),
the **AlgoKit CLI**, and a **build** step (the integration tests read the
gitignored `Campaign.arc56.json` artifact).

Steps:

1. Node + AlgoKit CLI (pipx, cached by version).
2. `algokit localnet start` — pulls the prebuilt algod/indexer sandbox images.
3. `npm run build` — compile the contracts.
4. `npm run test:integration` — deploy and exercise the full lifecycle.

This is intentionally a **separate workflow** from `test`: it's slower (~2–3 min
for the containers) and flakier than the pure-Node lane, so it shouldn't block
ordinary fast feedback. Its status check is named `localnet integration`.
