# Contract testing

How the `Campaign` contract is tested, and the plan for getting to full behavioral
coverage.

## Approach

Two complementary layers:

1. **Offline AVM unit tests** (`algorand-typescript-testing` + Vitest) — the main
   behavioral matrix. Runs in-process, no network, deterministic and fast. This is
   where "every method × every branch" is proven.
2. **LocalNet integration** (Phase 1 later step) — deploy with AlgoKit, exercise the
   flow through real algod. Proves the compiled TEAL behaves as the unit tests expect.

> The offline tests are not a substitute for the on-chain run — they're the fast
> feedback loop. Both are required before Phase 1 is "done".

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

## Test file naming (important)

The transformer only processes files whose name ends in `.algo.ts`, `.algo.spec.ts`
or `.algo.test.ts`. The contract (`contract.algo.ts`) is transformed; **the test file
must also be transformed**, so it must be named `contract.algo.spec.ts` (not plain
`.spec.ts`). Otherwise contract creation fails with "Cannot create a contract for
class as it does not extend Contract or BaseContract".

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

## Roadmap

- [x] **M0 — Harness.** Install tooling; `vitest.config.mts` + `vitest.setup.ts`;
      `npm run test` runs.
- [x] **M1 — Create + pledge.** `create` success + guard failures; `pledge` success,
      re-pledge accumulation, and every guard failure. (Also covered `claim` and
      `refund` happy paths + core guards while proving the harness.)
- [ ] **M2 — Settlement.** Remaining `claim` branches (double-claim) and `refund`
      branches (double-refund, multi-backer). See the matrix below.
- [ ] **M3 — Full matrix.** Sweep any remaining branches; check off the full matrix.
- [ ] **M4 — LocalNet integration.** Deploy to the sandbox, exercise
      create → pledge → claim and → refund end-to-end.

## Coverage matrix (every method × every branch)

| Method | Branch | Covered? |
| --- | --- | --- |
| `create` | success | ✅ |
| `create` | `goal == 0` | ✅ |
| `create` | `deadline <= latestTimestamp` | ✅ |
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
| `claim` | double claim (`status != Open`) | ⬜ |
| `refund` | success | ✅ |
| `refund` | before deadline | ✅ |
| `refund` | `raised >= goal` | ✅ |
| `refund` | non-backer (no box) | ✅ |
| `refund` | double refund (box deleted) | ⬜ |
| `refund` | second backer after first (status already `Failed`) | ⬜ |
