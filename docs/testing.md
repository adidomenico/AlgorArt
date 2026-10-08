# Contract testing

How the `Campaign` contract is tested: the full offline behavioral matrix plus
LocalNet integration.

## Approach

Two complementary layers:

1. **Offline AVM unit tests** (`algorand-typescript-testing` + Vitest) - the main
   behavioral matrix. Runs in-process, no network, deterministic and fast. This is
   where "every method × every branch" is proven.
2. **LocalNet integration** (`contract.integration.test.ts`) - deploy the compiled
   TEAL to a live algod and exercise the flow end-to-end. Proves the compiled
   bytecode behaves as the unit tests expect.

A third layer - **browser E2E / acceptance tests** - is planned but not yet
implemented; it drives the real UI against LocalNet and is described at the end
of this doc.

> The offline tests are not a substitute for the on-chain run - they're the fast
> feedback loop. Both are required before the contract is considered done.

## Tooling

- `@algorandfoundation/algorand-typescript-testing` - offline AVM emulation + test context.
- `vitest` - test runner.
- `@rollup/plugin-typescript` - applies the `puyaTsTransformer` so `.algo.ts` /
  `.algo.spec.ts` files run with AVM semantics in Node.

Config lives in:

- `vitest.config.mts` - wires `puyaTsTransformer` via the TypeScript plugin.
- `vitest.setup.ts` - registers `addEqualityTesters({ expect })` so `uint64` /
  `bytes` / `Account` values compare against native JS values in `expect(...)`.

Run with `npm run test` (see `package.json`).

Commands:

- `npm run test` - offline AVM unit tests only.
- `npm run test:integration` - LocalNet integration tests (requires
  `algokit localnet start` + `npm run build`).
- `npm run test:all` - both.
- `npm run test:coverage` - offline tests with coverage; fails below the
  configured thresholds (see below).

## Coverage

Coverage uses Vitest's built-in V8 provider (`@vitest/coverage-v8`). It measures
the contract source (`smart_contracts/**/*.algo.ts`) and excludes tests and
generated artifacts.

The **meaningful** metrics are lines, branches, and functions - all gated at
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
  `factory.integration.test.ts` - **plain `.test.ts`** files, so the puya
  transformer skips them (no AVM emulation; they talk to real algod).
- Uses `algorandFixture()` to fund throwaway accounts from the LocalNet dispenser.
- Loads the ARC-56 specs at runtime via `fs.readFileSync` with the generic
  `AppFactory` - avoids statically importing the gitignored `*Client.ts`,
  which would break `tsc --noEmit` in CI (artifacts aren't checked in).
- LocalNet algod runs in **dev mode**: block timestamp = previous tip timestamp +
  offset. `advanceTime(n)` sets the offset, produces any transaction (a self-payment
  "time bump"), then resets the offset in a `finally`.
- Two hand-testing scripts live in `projects/contracts/scripts/` (LocalNet only,
  run with `npx ts-node --transpile-only scripts/<name>.ts`):
  `fund-account.ts` (`ADDRESS=… [ALGO=…]`, dispenser-funds any empty wallet) and
  `advance-time.ts` (`SECONDS=…`, moves the chain clock past deadlines; the
  offset persists until changed, so new campaigns use it as their baseline).
- Inner transactions need fee pooling via `extraFee: (1000).microAlgo()` per
  inner txn - and each OpUp iteration submits *two* inners (create + delete), so
  `ensureBudget` calls cost double: pledge group (pay + pledge + credit with
  first-touch factory check) → 4000; `cancelPledge`/`refund`/`vault.refund`
  (1 OpUp iteration + payout call) → 4000; `claim` (inner app call + inner
  payment) → 3000; `delete` (settle/notify + escrow close) → 3000;
  `settleOpen` (no inners) → 1000; `finalize` → 2000 with residual, 1000
  without. Amounts are never reduced by fees.
- `pledge(pay,byte[])` reads the vault's app address from state, so the call
  carries no app references; the payment goes to the **vault app account**,
  never the escrow. The three transactions must form ONE group - and the SDK
  composer does not dedupe, so pass the payment either explicitly
  (`addTransaction`) or by method-arg reference, never both.
- `cancelPledge` / `refund(k,amount,txid,path)` / `vault.refund` take the path
  as one blob (`siblings ‖ top ‖ lower`); `delete()` needs the vault box
  declared even for pristine campaigns (settle no-ops without one).
- The vault's one 65-byte campaign box (`'c' + appId`) is declared on every
  outer transaction that triggers inner vault calls; first-touch `credit`
  additionally declares the Factory app plus its registration box
  (`'r' + appId`) for the inner `isRegistered` call. Inner calls to *oneself*
  are forbidden by consensus - budget headroom comes from `ensureBudget`, never
  self-calls. The vault's own methods get their boxes auto-populated from the
  ARC-56 spec.
- The setup chain is: `create(vault, …)` → `register`. There is no funding
   step - the escrow never holds funds.
- Post-settlement refunds call the vault directly:
  `refund(uint64,uint64,uint64,byte[],byte[])void` with the campaign app id -
  the vault verifies the path against its own stored root.
- `delete()` uses the dedicated `send.delete` path (or a manual composer group
  with `DeleteApplicationOC`); `send.call` with an `onComplete` override
  mis-encodes the call.
- Raw inner `appArgs` must ABI-encode dynamic types: the settle `root`
  (`byte[]`) carries its uint16 length prefix - static `uint64`/`address` args
  go raw.
- Do **not** pass `updatable`/`deletable` to `factory.send.create` - the contract TEAL
  has no deploy-time templates for them.

## Integration test inventory

All LocalNet integration tests in the repo (run with `npm run test:integration`; 16
tests across 3 files). Each file deploys its own fixture chain to a live algod.
Files run **sequentially** (`--no-file-parallelism`): they share one LocalNet
sandbox, and `setBlockOffsetTimestamp` time-travel is chain-global - parallel
files can jump the clock between another file's deploy and pledge, flaking with
`pledging is closed`. Sequential files keep each suite's chain-relative
deadlines (`+600s` at deploy) valid.
Offline specs live next to each contract (`contract.algo.spec.ts`: 35 campaign +
50 vault + 16 factory tests, all green with 100% line/branch/function coverage).

**Full ledger accounting.** Every integration test asserts the complete money
ledger, µA-exact, for every actor involved: balance and minimum-balance deltas
per account, the fee totals of each operation (measured on LocalNet - the
pledge group costs 4000 µA, spends and vault refunds 4000 µA, claims 3000 µA),
the vault pool movement, the parked box MBR (32,100 µA per campaign box on the
vault, released by `notifyDelete`/`finalize`), and the creator's sponsorship
floor (recovered at `delete()`). Rejected transactions are asserted to move
**nothing** (atomic failure charges no fee).

**Differential tree assertions.** Pledge/cancel/refund tests drive the Python
reference oracle (`smart_contracts/oracle.py`, backed by
`docs/claim-tree-protocol-reference.py`) with the REAL confirmed payment TxIDs
and assert `root`/`n`/`raised` - plus the vault box's `paidIn`/`paidOut` - after
every step. Forged frontiers, stale proofs, and double-spends are asserted to
reject with state untouched.

### `smart_contracts/campaign/contract.integration.test.ts` (8 tests)

The full claim-tree lifecycle plus the attack matrix, deployed against a real
Factory + ClaimsVault + Campaign.

| # | Test | Verifies |
| --- | --- | --- |
| 1 | embedded vault selectors match the vault ARC-56 | The four inner-call selectors recomputed from the ARC-56 appear in the campaign TEAL |
| 2 | pledge → cancel → refund lifecycle, differentially verified | Four pledges (one re-pledge) with per-step root/n/raised + `paidIn`; forged-frontier rejection; pre-deadline cancel; non-sequential post-deadline refunds to zero; double-refund rejection |
| 3 | unregistered campaigns cannot touch the vault | First-touch `credit` fails with `campaign not registered`; no box is created |
| 4 | inner-only vault methods reject top-level callers | Direct `payBack`/`payClaim`/`settle`/`notifyDelete` fail with `not the campaign app` - the payout authority is unusable off the campaign path |
| 5 | successful claim pays the creator exactly, then deletes O(1) | Goal reached → creator paid the full live total; box `Claimed`; `notifyDelete` releases the box; unregister returns the deposit |
| 6 | failed campaign settles on delete; vault refunds after deletion; finalize sweeps the residual | `settle` writes root/N/`Failed`; permissionless `vault.refund` pays post-delete; early `finalize` rejected; post-window residual goes to the sweep target and the box is gone |
| 7 | pristine and all-cancelled campaigns delete cleanly | No-box delete settles as a no-op; fully-cancelled delete settles to `Failed` with nothing owed |
| 8 | settleOpen lets a stranger settle a vanished-creator campaign | Permissionless settle from live globals; the campaign path then rejects (box not open) and the vault path serves refunds |

### `smart_contracts/claimsvault/contract.integration.test.ts` (4 tests)

| # | Test | Verifies |
| --- | --- | --- |
| 9 | first touch creates the box with exact MBR accounting | Box fields on first pledge; pool total rises by exactly the pledge; minimum balance parks exactly 32,100 µA |
| 10 | two campaigns share the pool with per-campaign isolation | Draining campaign A leaves B's box (root, `paidOut` 0) untouched; the pool holds exactly B's live pledge |
| 11 | settleOpen + vault refunds + zero-residual finalize | Stranger settlement; direct refund + double-refund rejection; `finalize` with nothing left deletes the box with no payment and frees the MBR |
| 12 | direct credit without a pledge strands only the deviator funds (spec §17 #29) | `paidIn` counts the real inflow but no leaf exists; pristine delete settles the stray box; post-window `finalize` sweeps the stray inflow and deletes the box - nobody else affected |

### `smart_contracts/factory/contract.integration.test.ts` (4 tests)

| # | Test | Verifies |
| --- | --- | --- |
| 13 | register/isRegistered/unregister round trip with a real Campaign | Registration against the real deployed program hash; the deposit lands on the Factory and returns on unregister; `isRegistered` reflects the state |
| 14 | an impostor copy of the Campaign contract cannot register | The program-hash check rejects a non-official program |
| 15 | a non-creator cannot register someone else's campaign, and registration is refused before the hash is configured | Creator gating; unconfigured-hash refusal |
| 16 | only the owner can set the official hash, and only the registered creator can unregister | Factory ownership and deposit protection |

## API cheat sheet (learned the hard way)

- `const ctx = new TestExecutionContext()`; **create the context once per suite and
  call `ctx.reset()` in `beforeEach`** - constructing a second context throws
  ("Execution context has already been set").
- `ctx.contract.create(Campaign)` returns a proxied instance.
- `Campaign extends Contract` (ARC4), so `@abimethod` methods auto-assemble an app-call
  transaction group when called directly:
  - `contract.create(vault, title, uri, goal, deadline)` works - the `onCreate: 'require'` guard is
    enforced via the runtime's `isCreating` flag, not a real app-id check.
  - `contract.pledge(payment, frontier)` takes a `ctx.any.txn.payment({ sender, receiver, amount })`
    (its `txnId` is readable for oracle-differential assertions); the frontier is plain bytes.
- `Txn.sender` defaults to `ctx.defaultSender`. To act as a different account, wrap the
  call:

  ```ts
  ctx.txn.createScope([ctx.any.txn.applicationCall({ appId: contract, sender: other })]).execute(() => {
    contract.claim()
  })
  ```

- `Global.latestTimestamp` defaults to `Date.now()` (ms) per group - **patch it
  explicitly** before `create`/settlement tests:
  `ctx.ledger.patchGlobalData({ latestTimestamp: 1000 })`. Remember the `create` guard
  is `deadline > latestTimestamp` (strict), so pin the creation time and use a larger
  deadline.
- App escrow address: `ctx.ledger.getApplicationForContract(contract).address`.
- Inner app calls to stub apps succeed as no-ops, but their logs are NOT emulated:
  gate the call on `lastLog` only on LocalNet, and `v8 ignore` the gate offline
  (see `checkRegistration`).
- Inner-call targets must be `Application`-typed state (not bare `uint64` ids) -
  the offline emulator only resolves those.
- Inner payments (from `claim`/`refund`/`cancelPledge`/`delete`/`finalize`): assert via
  `ctx.txn.lastGroup.lastItxnGroup().getPaymentInnerTxn()`; inner app calls via
  `getApplicationCallInnerTxn()` (its `appArgs(0)` carries the method selector -
  assert it to keep the embedded selectors in sync).
- `ensureBudget` OpUp loops run offline (each iteration submits two inners); size
  `extraFee` accordingly on LocalNet (measured table in
  [`campaign.md`](campaign.md)).
- Failure assertions: `assert` throws `AssertError` with the message, so
  `expect(() => ...).toThrowError('...')` works verbatim.
- `vitest.config.mts` must override `compilerOptions.module: 'esnext'` (the contract
  tsconfig is CommonJS); otherwise the transformer-injected `runtime-helpers` import
  fails against the package's ESM-only exports map.
- `package.json` test script uses `--no-color` to keep AlgoKit's command output clean.
- PuyaTs arithmetic: `+ - *` and comparisons are overloaded for `uint64`, but
  `/ % >> << ^ & |` fall back to JS `number` semantics - use `op.shr`/`op.shl`
  and annotate every derived numeric local, or compilation fails with
  "`number` is not valid".

## Coverage matrix (every method × every branch)

| Method | Branch | Covered? |
| --- | --- | --- |
| `create` | success / empty title / overlong title+uri / `goal == 0` / past deadline | ✅ |
| `pledge` | success incl. re-pledge / closed / not open / wrong receiver / wrong sender / zero / creator self-pledge / bad frontier length / forged + stale frontier | ✅ |
| `claim` | success with inner `payClaim` (LocalNet) / non-creator / before deadline / `raised < goal` / double claim | ✅ |
| `refund` | success / before deadline / `raised >= goal` / claimed / bad txid / unknown position / bad path / proof mismatch / double refund (LocalNet) | ✅ |
| `cancelPledge` | success / after deadline / not open / zero amount / bad txid / unknown position / bad path / double cancel (LocalNet) | ✅ |
| `delete` | failed-in-fact materialization + vault settle / claimed + notifyDelete / pristine (settle no-op) / all-cancelled settle / non-creator / live pledges | ✅ |
| `ClaimsVault.create` | success / zero window | ✅ |
| `credit` | existing-box inflow / zero amount / unregistered first touch / closed box / no matching payment | ✅ (+ first-touch happy path on LocalNet) |
| `payBack` | success / non-campaign caller / unknown campaign / closed box / zero / insufficient | ✅ |
| `payClaim` | success (derived amount) / non-campaign caller / unknown / closed box / empty payout | ✅ |
| `settle` | success / already failed (no-op) / missing box (no-op) / claimed / non-campaign caller / bad root | ✅ |
| `settleOpen` | success from live globals / unknown / closed box / claimed campaign / early deadline / reached goal | ✅ |
| `vault.refund` | success differentially (LocalNet) / unknown / not failed / window closed / unknown position / bad txid+path / proof mismatch / insufficient | ✅ |
| `notifyDelete` | success / non-campaign caller / unknown / not claimed / unbalanced | ✅ |
| `finalize` | residual sweep + box delete / zero-residual delete / unknown / not failed / window open (all LocalNet) | ✅ |
| `Factory.register` | success / unconfigured hash / non-creator / impostor / low deposit / wrong payer / wrong receiver / double registration | ✅ |
| `Factory.unregister` | success (deposit back) / unregistered / non-creator | ✅ |
| Attacks (LocalNet) | double-spend / stale + forged proofs / unregistered credit / top-level inner-only calls / settleOpen interplay / window enforcement / self-harm containment (§17 #29) / pooled isolation | ✅ |

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
in the frontend helpers (for example, `coverAppCallInnerTransactionFees: true`,
which throws at send time because the typed client doesn't populate the required
`maxFee` context) passes unit tests and integration tests, and fails only when a
real user clicks a button. Browser E2E tests close this gap.

### Scope

- **Connect wallet** - via a test signer standing in for Pera/Defly (see below),
  not a real wallet popup.
- **Browse** - campaign list renders seeded campaigns.
- **Create** - fill the form, submit, assert the new campaign appears.
- **Pledge** - enter an amount, submit, assert `raised` and "Your pledge" update.
- **Cancel pledge** - assert the button appears only while `open` with a pledge,
  and that clicking it returns the pledge (raised drops back, the leaf is gone).
- **Claim / refund** - after fast-forwarding the deadline, assert the creator /
  backer flows complete.

### Wallet strategy

Automating real Pera/Defly wallet popups is brittle and out of scope for a
first cut. The plan is to inject a **test signer** (a LocalNet-funded mnemonic)
so the app signs transactions without a real wallet. This reuses the existing
`WalletSession` shape (`{ address, signer }`) in `lib/transaction.ts`. The
remaining questions to settle before implementing:

- Whether to run against the `npm run dev` Vite server or a `vite build` preview
  (preview is closer to prod, dev is faster to iterate).
- Playwright vs. Vitest browser mode (Playwright is the natural fit for
  click-driven flows; Vitest browser mode keeps it in the existing runner).
- How to seed campaigns idempotently before each run (`npm run seed` / `npm run unseed` in
  `projects/contracts`, state-tracked via `scripts/.seed-state.json`; LocalNet by default,
  `DOTENV_CONFIG_PATH=.env.testnet` for TestNet) and reclaim afterwards (`npm run reclaim` in
  `projects/frontend`: refunds/cancels known leaves, deletes, unregisters; unknown leaves reported).

### Where it lives

TBD once the tooling is chosen, but expected under `projects/frontend/e2e/` (or a
new top-level `e2e/`), with its own script wired into `package.json`. CI wiring
comes later - see [`ci.md`](ci.md).
