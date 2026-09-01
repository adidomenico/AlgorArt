# Contract testing

How the `Campaign` contract is tested: the full offline behavioral matrix plus
LocalNet integration.

## Approach

Two complementary layers:

1. **Offline AVM unit tests** (`algorand-typescript-testing` + Vitest) — the main
   behavioral matrix. Runs in-process, no network, deterministic and fast. This is
   where "every method × every branch" is proven.
2. **LocalNet integration** (`contract.integration.test.ts`) — deploy the compiled
   TEAL to a live algod and exercise the flow end-to-end. Proves the compiled
   bytecode behaves as the unit tests expect.

> The offline tests are not a substitute for the on-chain run — they're the fast
> feedback loop. Both are required before the contract is considered done.

## Tooling

- `@algorandfoundation/algorand-typescript-testing` — offline AVM emulation + test context.
- `vitest` — test runner.
- `@rollup/plugin-typescript` — applies the `puyaTsTransformer` so `.algo.ts` /
  `.algo.spec.ts` files run with AVM semantics in Node.

Config lives in:

- `vitest.config.mts` — wires `puyaTsTransformer` via the TypeScript plugin.
- `vitest.setup.ts` — registers `addEqualityTesters({ expect })` so `uint64` /
  `bytes` / `Account` values compare against native JS values in `expect(...)`.

Run with `npm run test` (see `package.json`).

Commands:

- `npm run test` — offline AVM unit tests only.
- `npm run test:integration` — LocalNet integration tests (requires
  `algokit localnet start` + `npm run build`).
- `npm run test:all` — both.
- `npm run test:coverage` — offline tests with coverage; fails below the
  configured thresholds (see below).

## Coverage

Coverage uses Vitest's built-in V8 provider (`@vitest/coverage-v8`). It measures
the contract source (`smart_contracts/**/*.algo.ts`) and excludes tests and
generated artifacts.

The **meaningful** metrics are lines, branches, and functions — all gated at
100% in `vitest.config.mts`. Statements are intentionally left un-thresholded:
the `@abimethod` decorator wraps each method signature in a statement V8 never
marks as executed, so statement coverage tops out at ~93% even when every real
line is covered.

Run it with `npm run test:coverage`. The thresholds live in
`vitest.config.mts` and are ready to be enforced as a CI gate when the test
workflow is added.

## Test file naming (important)

The transformer only processes files whose name ends in `.algo.ts`, `.algo.spec.ts`
or `.algo.test.ts`. The contract (`contract.algo.ts`) is transformed; **the test file
must also be transformed**, so it must be named `contract.algo.spec.ts` (not plain
`.spec.ts`). Otherwise contract creation fails with "Cannot create a contract for
class as it does not extend Contract or BaseContract".

## LocalNet integration notes

- Integration tests live in `contract.integration.test.ts` — a **plain `.test.ts`**
  file, so the puya transformer skips it (no AVM emulation; it talks to real algod).
- Uses `algorandFixture()` to fund throwaway accounts from the LocalNet dispenser.
- Loads `Campaign.arc56.json` at runtime via `fs.readFileSync` with the generic
  `AppFactory` — avoids statically importing the gitignored `CampaignClient.ts`,
  which would break `tsc --noEmit` in CI (artifacts aren't checked in).
- LocalNet algod runs in **dev mode**: block timestamp = previous tip timestamp +
  offset. `advanceTime(n)` sets the offset, produces any transaction (a self-payment
  "time bump"), then resets the offset in a `finally`.
- `claim`/`refund` issue an inner payment, so they need `extraFee: (1000).microAlgo()`.
- Box references for `pledge`/`refund` are auto-populated (`populateAppCallResources`
  defaults to true).
- Do **not** pass `updatable`/`deletable` to `factory.send.create` — the contract TEAL
  has no deploy-time templates for them.

## API cheat sheet (learned the hard way)

- `const ctx = new TestExecutionContext()`; **create the context once per suite and
  call `ctx.reset()` in `beforeEach`** — constructing a second context throws
  ("Execution context has already been set").
- `ctx.contract.create(Campaign)` returns a proxied instance.
- `Campaign extends Contract` (ARC4), so `@abimethod` methods auto-assemble an app-call
  transaction group when called directly:
  - `contract.create(goal, deadline)` works — the `onCreate: 'require'` guard is
    enforced via the runtime's `isCreating` flag, not a real app-id check.
  - `contract.pledge(payment)` takes a `ctx.any.txn.payment({ sender, receiver, amount })`.
- `Txn.sender` defaults to `ctx.defaultSender`. To act as a different account, wrap the
  call:

  ```ts
  ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other })]).execute(() => {
    contract.claim()
  })
  ```

- `Global.latestTimestamp` defaults to `Date.now()` (ms) per group — **patch it
  explicitly** before `create`/settlement tests:
  `ctx.ledger.patchGlobalData({ latestTimestamp: 1000 })`. Remember the `create` guard
  is `deadline > latestTimestamp` (strict), so pin the creation time and use a larger
  deadline.
- App escrow address: `ctx.ledger.getApplicationForContract(contract).address`.
- Escrow balance is not moved by payment txns in the offline runtime; set it with
  `ctx.ledger.patchAccountData(appAddress, { account: { balance: N } })`
  (`balance` is nested under `account`). Default min balance is `100_000`, so
  `escrowBalance() = balance - 100_000`.
- Box state: `contract.pledges(account)` returns a `Box<uint64>`; use `.exists`,
  `.value`, `.get({ default: 0 })`.
- Inner payments (from `claim`/`refund`): assert via
  `ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()`.
- Failure assertions: `assert` throws `AssertError` with the message, so
  `expect(() => ...).toThrowError('...')` works verbatim.
- `vitest.config.mts` must override `compilerOptions.module: 'esnext'` (the contract
  tsconfig is CommonJS); otherwise the transformer-injected `runtime-helpers` import
  fails against the package's ESM-only exports map.
- `package.json` test script uses `--no-color` to keep AlgoKit's command output clean.

## Milestones (done)

- [x] **M0 — Harness.** Install tooling; `vitest.config.mts` + `vitest.setup.ts`;
      `npm run test` runs.
- [x] **M1 — Create + pledge.** `create` success + guard failures; `pledge` success,
      re-pledge accumulation, and every guard failure. (Also covered `claim` and
      `refund` happy paths + core guards while proving the harness.)
- [x] **M2 — Settlement.** Remaining `claim` branch (double-claim) and `refund`
      branches (double-refund, multi-backer).
- [x] **M3 — Full matrix.** Added the `create`-once branch; every method × every
      branch is now covered (see the matrix below).
- [x] **M4 — LocalNet integration.** Deploy to the sandbox, exercise
      create → pledge → claim and → refund end-to-end.

## Coverage matrix (every method × every branch)

| Method | Branch | Covered? |
| --- | --- | --- |
| `create` | success | ✅ |
| `create` | `goal == 0` | ✅ |
| `create` | `deadline <= latestTimestamp` | ✅ |
| `create` | called again (not app-create) | ✅ |
| `pledge` | success (first pledge) | ✅ |
| `pledge` | re-pledge accumulates | ✅ |
| `pledge` | `amount == 0` | ✅ |
| `pledge` | wrong receiver | ✅ |
| `pledge` | payer ≠ caller | ✅ |
| `pledge` | after deadline | ✅ |
| `claim` | success | ✅ |
| `claim` | non-creator | ✅ |
| `claim` | before deadline | ✅ |
| `claim` | `raised < goal` | ✅ |
| `claim` | double claim (`status != Open`) | ✅ |
| `refund` | success | ✅ |
| `refund` | before deadline | ✅ |
| `refund` | `raised >= goal` | ✅ |
| `refund` | non-backer (no box) | ✅ |
| `refund` | double refund (box deleted) | ✅ |
| `refund` | second backer after first (status already `Failed`) | ✅ |
