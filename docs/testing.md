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

A third layer — **browser E2E / acceptance tests** — is planned but not yet
implemented; it drives the real UI against LocalNet and is described at the end
of this doc.

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

- Integration tests live in `contract.integration.test.ts` and
  `factory.integration.test.ts` — **plain `.test.ts`** files, so the puya
  transformer skips them (no AVM emulation; they talk to real algod).
- Uses `algorandFixture()` to fund throwaway accounts from the LocalNet dispenser.
- Loads the ARC-56 specs at runtime via `fs.readFileSync` with the generic
  `AppFactory` — avoids statically importing the gitignored `*Client.ts`,
  which would break `tsc --noEmit` in CI (artifacts aren't checked in).
- LocalNet algod runs in **dev mode**: block timestamp = previous tip timestamp +
  offset. `advanceTime(n)` sets the offset, produces any transaction (a self-payment
  "time bump"), then resets the offset in a `finally`.
- Inner transactions need fee pooling via `extraFee: (1000).microAlgo()` per
  inner txn (`fund`/`pledge`/`claim`/`refund`/`cancelPledge` → 1000; `delete`
  with the ASA → 2000).
- `pledge(pay)void` mints claim units via an inner asset transfer, so the call
  must carry `assetReferences: [claimAsa]`. `refund(axfer)void` /
  `cancelPledge(axfer)void` / `closeOut(axfer)void` take the backer's own asset
  transfer as the ABI argument — the group pools its asset, no explicit
  reference needed. `delete()void` needs `assetReferences: [claimAsa]` for the
  supply check and destroy.
- Backers must `assetOptIn` to the Claim ASA before pledging (the mint inner
  txn fails otherwise and the whole group reverts).
- `closeOut` uses the `closeAssetTo` parameter on `createTransaction.assetTransfer`
  (not `closeRemainderTo`, which is the payment field).
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
- Asset effects are **not** applied offline: the inner `assetConfig`/`assetTransfer`
  txns execute but don't move balances, so mint/surrender/double-spend behavior is
  proven on LocalNet instead. Capture the issued Claim ASA for gtxn assertions with
  `ctx.txn.lastGroup.lastItxnGroup().getAssetConfigInnerTxn().createdAsset`.
- Inner payments (from `claim`/`refund`/`cancelPledge`/`delete`): assert via
  `ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()`.
- ABI asset-transfer arguments come from `ctx.any.txn.assetTransfer({ sender, xferAsset,
  assetReceiver, assetAmount, assetCloseTo })`, created inside the `createScope` block.
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
- [x] **M5 — `cancelPledge`.** Contract method + offline behavioral tests +
      frontend wiring (helper, detail-page action, unit tests).
- [x] **M6 — guarded `delete()`.** Contract method + offline guard tests +
      LocalNet integration covering the full money flow with three backers,
      asserting balances, minimum balances (MBR), fees, and the sponsorship-floor
      free on every step.
- [x] **M7 — Claim ASA redesign.** Replaced the Merkle/spent-bitmap machinery with
      the per-campaign Claim ASA (`fund` issues it, `pledge` mints, refunds
      surrender), added `closeOut`, the Factory registry contract, and full
      offline + LocalNet coverage of the new lifecycle, MBR accounting, and the
      double-refund invariants.

## Coverage matrix (every method × every branch)

| Method | Branch | Covered? |
| --- | --- | --- |
| `create` | success | ✅ |
| `create` | `goal == 0` | ✅ |
| `create` | `deadline <= latestTimestamp` | ✅ |
| `create` | empty title | ✅ |
| `fund` | success (issues the Claim ASA, records the deposit) | ✅ |
| `fund` | second fund (`claimAsa != 0`) | ✅ |
| `fund` | non-creator | ✅ |
| `fund` | `amount < MIN_DEPOSIT` | ✅ |
| `fund` | settled campaign | ✅ |
| `pledge` | success (mints units, bumps `raised`) | ✅ |
| `pledge` | re-pledge accumulates | ✅ |
| `pledge` | before `fund()` (no Claim ASA yet) | ✅ |
| `pledge` | creator self-pledge | ✅ |
| `pledge` | `amount == 0` | ✅ |
| `pledge` | after deadline | ✅ |
| `claim` | success | ✅ |
| `claim` | non-creator | ✅ |
| `claim` | before deadline | ✅ |
| `claim` | `raised < goal` | ✅ |
| `claim` | double claim (`status != Open`) | ✅ |
| `refund` | success (full surrender, exact payout) | ✅ |
| `refund` | partial refund | ✅ |
| `refund` | before deadline | ✅ |
| `refund` | `raised >= goal` | ✅ |
| `refund` | claimed campaign | ✅ |
| `refund` | surrender with `closeRemainderTo` set | ✅ |
| `refund` | wrong asset | ✅ |
| `refund` | zero amount | ✅ |
| `refund` | wrong receiver | ✅ |
| `refund` | double refund (units gone — LocalNet) | ✅ |
| `refund` | non-holder (no units — LocalNet) | ✅ |
| `cancelPledge` | success (decrements `raised`) | ✅ |
| `cancelPledge` | after deadline | ✅ |
| `cancelPledge` | settled campaign | ✅ |
| `cancelPledge` | surrender with `closeRemainderTo` set | ✅ |
| `cancelPledge` | double cancel (units gone — LocalNet) | ✅ |
| `closeOut` | success (claimed campaign) | ✅ |
| `closeOut` | not claimed | ✅ |
| `closeOut` | without `closeRemainderTo` | ✅ |
| `closeOut` | wrong receiver | ✅ |
| `delete` | success (failed, fully refunded — destroy ASA + close) | ✅ |
| `delete` | success (claimed, all units closed out — destroy ASA + close) | ✅ |
| `delete` | never-funded open campaign | ✅ |
| `delete` | non-creator | ✅ |
| `delete` | open campaign with live pledges | ✅ |
| `delete` | outstanding claim units | ✅ |
| `Factory.create` / `setApprovalHash` | owner + length guards | ✅ |
| `Factory.register` | success / unconfigured hash / non-creator / impostor program / low deposit / wrong payer / wrong receiver / double registration | ✅ |
| `Factory.unregister` | success (deposit back) / unregistered / non-creator | ✅ |

## Browser E2E / acceptance tests

**Status: planned, not yet implemented.**

This layer drives the real UI in a browser against a running LocalNet, clicking
buttons and checking observable results the way a user would: connect a wallet,
browse, create a campaign, pledge, cancel a pledge, claim, and refund. It
complements the two layers above rather than replacing them.

### Why it's needed

The existing layers share one blind spot: they do not exercise the **frontend
send path** (`lib/transaction.ts`) against a live chain. The contract
integration tests call the low-level client directly (with `extraFee`), so a bug
in the frontend helpers — e.g. using `coverAppCallInnerTransactionFees: true`,
which throws at send time because the typed client doesn't populate the required
`maxFee` context — passes unit tests and integration tests but fails the moment a
real user clicks a button. That exact bug shipped and was only caught manually.
Browser E2E tests close this gap.

### Scope

- **Connect wallet** — via a test signer standing in for Pera/Defly (see below),
  not a real wallet popup.
- **Browse** — campaign list renders seeded campaigns.
- **Create** — fill the form, submit, assert the new campaign appears.
- **Pledge** — enter an amount, submit, assert `raised` and "Your pledge" update.
- **Cancel pledge** — assert the button appears only while `open` with a pledge,
  and that clicking it returns the pledge (raised drops back, units are gone).
- **Claim / refund** — after fast-forwarding the deadline, assert the creator /
  backer flows complete.

### Wallet strategy (the main design decision)

Automating real Pera/Defly wallet popups is brittle and out of scope for a
first cut. The plan is to inject a **test signer** (a LocalNet-funded mnemonic)
so the app signs transactions without a real wallet. This reuses the existing
`WalletSession` shape (`{ address, signer }`) in `lib/transaction.ts`. The
remaining questions to settle before implementing:

- Whether to run against the `npm run dev` Vite server or a `vite build` preview
  (preview is closer to prod, dev is faster to iterate).
- Playwright vs. Vitest browser mode (Playwright is the natural fit for
  click-driven flows; Vitest browser mode keeps it in the existing runner).
- How to seed LocalNet campaigns idempotently before each run (the existing
  `scripts/seed-demo.ts` is a starting point).

### Where it lives

TBD once the tooling is chosen, but expected under `projects/frontend/e2e/` (or a
new top-level `e2e/`), with its own script wired into `package.json`. CI wiring
comes later — see [`ci.md`](ci.md).
