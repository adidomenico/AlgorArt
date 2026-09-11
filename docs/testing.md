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
  inner txn: `fund`/`pledge` → 1000; `claim`/`refund`/`cancelPledge` (inner app
  call + inner payment) → 2000; `delete` (settle + holding close + escrow
  close) → 3000 with an asset, 1000 without.
- `pledge(pay)void` mints claim units via an inner asset transfer and reads the
  vault's app address, so the call carries `appReferences: [vaultId]` and
  `assetReferences: [claimAsa]`. The payment goes to the **vault app account**,
  never the escrow.
- `claim()` / `refund(axfer)` / `cancelPledge(axfer)` / `delete()` inner-call
  the vault, whose BoxMap reads/writes require the box names to be declared on
  the outer transaction — pass `boxReferences` for the vault's campaign boxes
  (`a`/`d` for payouts, `a`/`d`/`s` for settle, `a`/`d`/`o`/`s` for claims; the
  AVM rejects undeclared box access with "invalid Box reference"). The vault's
  own methods get their boxes auto-populated from the ARC-56 spec.
- The setup chain is: `create(vault)` → `fund` → (register) →
  `vault.issueClaimAsa` → `attachClaimAsa` (escrow self-opt-in) →
  `vault.seedSupply`. The zero-amount opt-in trick only works self-signed
  (sender == receiver), so the campaign opts itself in — the vault cannot opt
  the escrow in for it (measured: "receiver error: must optin").
- Backers must `assetOptIn` to the Claim ASA before pledging (the mint inner
  txn fails otherwise and the whole group reverts).
- Post-delete refunds call the vault directly: `refund(uint64,axfer)void` with
  the campaign app id — the vault verifies it against its own `asaOf` mapping.
- `closeOut` uses the `closeAssetTo` parameter on `createTransaction.assetTransfer`
  (not `closeRemainderTo`, which is the payment field).
- Do **not** pass `updatable`/`deletable` to `factory.send.create` — the contract TEAL
  has no deploy-time templates for them.

## Integration test inventory

All LocalNet integration tests in the repo (run with `npm run test:integration`; 19
tests across 3 files). Each file deploys its own fixture chain to a live algod.

### `smart_contracts/campaign/contract.integration.test.ts` (14 tests)

The full split-vault lifecycle plus the attack matrix, deployed against a real
Factory + ClaimsVault + Campaign.

| # | Test | Verifies |
| --- | --- | --- |
| 1 | setup: the vault issues the Claim ASA and seeds the escrow; creator capital is the escrow constant | ASA config (creator/manager/clawback/reserve = vault, total 2⁶⁴−1, 0 decimals); the escrow holds the whole supply and exactly the 0.2 ALGO deposit; the vault parks its created-asset MBR |
| 2 | pledge: pays the vault (escrow untouched), mints claim units, accumulates | Payments land in the vault (escrow balance unchanged); the mint equals the payment; repeated pledges accumulate on the backer |
| 3 | pledge guards: no claim asset, wrong receiver, creator self-pledge | `claim asset not issued yet`; a payment to the escrow instead of the vault is rejected; the creator cannot self-pledge |
| 4 | attachClaimAsa rejects a counterfeit asset (wrong creator) | Provenance verification: a decoy ASA created by a random account cannot be attached (fake-vault campaigns are inert) |
| 5 | cancelPledge: the vault pays, raised decrements, units are consumed once | Pre-deadline withdrawal pays from the vault, decrements `raised`, consumes the units; a second cancel of the same units fails |
| 6 | **FLAGSHIP** — failed campaign with a straggler: creator deletes in O(1), the straggler refunds from the vault afterwards | The failed settlement is recorded inside `delete()`; the creator recovers deposit + sponsorship floor in one call; the never-acting backer then refunds **directly from the vault after the campaign is deleted**; after the last refund the vault destroys the ASA and frees its parked MBR |
| 7 | vault refund guards: unsettled campaign, wrong asset, zero amount, close-out forbidden | The vault refuses refunds before settlement; a decoy asset fails the surrender (receiver must opt in); zero-amount surrenders are rejected |
| 8 | claim guards: below goal, non-creator | `goal not reached`; `only the creator can claim` |
| 9 | cross-campaign isolation: units of one campaign can never redeem on another | Campaign A's units resolve to A's settlement (rejected when A is open); B's units refund only B's pledge — A's balance untouched |
| 10 | insolvency attack: payouts never exceed contributions across two campaigns | Both campaigns refund in full after deletion; the vault's balance drops by exactly the two pledges — no cross-campaign drain |
| 11 | funded flow: vault pays the claim from unit conservation; closeOut, sweep, destroy, full cleanup | The vault pays the derived amount (total − holdings); double claim and refunds rejected; O(1) delete recovers deposit + floor; `sweepClaimAsa` claws worthless units; `destroyClaimAsa` is refused while units are outstanding, then frees exactly 156,400 µA of vault MBR |
| 12 | vault payout methods reject non-campaign callers (no hijacking) | Direct `payBack`/`payClaim`/`settle` calls by strangers fail with `not the campaign app` — the payout authority is unusable off the campaign path |
| 13 | stray ALGO sent to the vault cannot be extracted by anyone | A random deposit inflates the pool but no payout path references it |
| 14 | an abandoned campaign (created, funded, never issued) can be deleted by its creator | The no-asset delete path frees the sponsorship floor with no residual |

### `smart_contracts/claimsvault/contract.integration.test.ts` (1 test)

| # | Test | Verifies |
| --- | --- | --- |
| 15 | issueClaimAsa guards: non-creator, non-official program, double issue; seedSupply is one-shot | Only the campaign creator can issue; a program that does not hash to the Factory's official hash is refused; a second issue is rejected; the supply can be seeded exactly once (second seed → `supply already seeded`) |

### `smart_contracts/factory/contract.integration.test.ts` (4 tests)

| # | Test | Verifies |
| --- | --- | --- |
| 16 | register/isRegistered/unregister round trip with a real Campaign | Registration against the real deployed program hash; the deposit lands on the Factory and returns on unregister; `isRegistered` reflects the state |
| 17 | an impostor copy of the Campaign contract cannot register | The program-hash check rejects a non-official program |
| 18 | a non-creator cannot register someone else's campaign, and registration is refused before the hash is configured | Creator gating; unconfigured-hash refusal |
| 19 | only the owner can set the official hash, and only the registered creator can unregister | Factory ownership and deposit protection |

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
- [x] **M8 — Split vault.** Moved the backers' funds into a permanent
      ClaimsVault (pooled refund escrow + Claim ASA issuer); the campaign escrow
      now holds only the creator's deposit, so both settlement paths finalize in
      O(1) — including the flagship straggler scenario (creator deletes; the
      straggler refunds from the vault afterwards). Added the attack matrix:
      cross-campaign isolation, pooled solvency, settlement-after-deletion,
      counterfeit assets, double claims, pledge→cancel→refund, payout-authority
      hijacking, stray-ALGO, and the GC round trip (sweep + destroy frees the
      vault's parked MBR).

## Coverage matrix (every method × every branch)

| Method | Branch | Covered? |
| --- | --- | --- |
| `create` | success / empty title / `goal == 0` / past deadline | ✅ |
| `fund` | success / non-creator / below MBR / already attached | ✅ |
| `attachClaimAsa` | success / wrong creator / wrong manager / wrong clawback / wrong supply / wrong decimals / double attach | ✅ |
| `pledge` | success / re-pledge / before attach / wrong receiver (escrow) / creator self-pledge / zero / after deadline | ✅ |
| `claim` | success (vault inner call) / non-creator / before deadline / `raised < goal` / double claim | ✅ |
| `refund` | success / partial / before deadline / `raised >= goal` / claimed / close-remainder / wrong receiver / double refund (LocalNet) / non-holder (LocalNet) | ✅ |
| `cancelPledge` | success / after deadline / settled / close-remainder / double cancel (LocalNet) | ✅ |
| `closeOut` | success / not claimed / without close-remainder / wrong receiver | ✅ |
| `delete` | failed-in-fact materialization + vault settle / claimed / never-funded / non-creator / live pledges | ✅ |
| `ClaimsVault.create` | success | ✅ |
| `issueClaimAsa` | success / hash not configured / impostor program / non-creator / double issue | ✅ |
| `seedSupply` | success (LocalNet) / double seed / unknown campaign | ✅ |
| `payBack` | success / non-campaign caller / unknown campaign | ✅ |
| `payClaim` | success (derived amount) / double claim / non-campaign caller | ✅ |
| `settle` | success / double settle / non-campaign caller | ✅ |
| `vault.refund` | success (post-delete — LocalNet) / mismatched campaign id / unsettled / zero amount / wrong receiver / counterfeit asset | ✅ |
| `sweepClaimAsa` | success (LocalNet) / not claimed | ✅ |
| `destroyClaimAsa` | success (LocalNet, frees 156,400 µA) / not settled / units outstanding | ✅ |
| `Factory.register` | success / unconfigured hash / non-creator / impostor / low deposit / wrong payer / wrong receiver / double registration | ✅ |
| `Factory.unregister` | success (deposit back) / unregistered / non-creator | ✅ |
| Attacks (LocalNet) | cross-campaign isolation / pooled insolvency / counterfeit attach / pledge→cancel→refund / payout hijacking / stray ALGO / straggler settlement-after-deletion | ✅ |

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
