# Campaign contract

The `Campaign` contract (`smart_contracts/campaign/contract.algo.ts`) is one half of AlgorArt's escrow: a non-custodial crowdfunding
campaign whose **escrow holds nothing at all** — not backer funds, not even a creator deposit. Backers' pledged ALGO lives in the
permanent **ClaimsVault** (`smart_contracts/claimsvault/contract.algo.ts`), which holds all campaigns' pledges in one pooled account
and pays cancellations, refunds, and successful claims.

A backer's receipt is their pledge **leaf in the campaign's incremental frontier-Merkle tree** — no ASA, no boxes, no per-backer
storage anywhere. The full protocol (tree math, proofs, accounting invariants, attack analysis) lives in
[`claim-tree-protocol.md`](claim-tree-protocol.md); this file covers the contract mechanics.

Source of truth is the Algorand chain. The contract — not a server — enforces the campaign rules.

## Contract vs application

**Contract** = the code: `contract.algo.ts`, compiled into TEAL approval/clear programs. **Application** = one deployed instance of that
code, with an app ID and global state. The associated **app account** (the escrow) is never funded and holds nothing.

Deployment is a single `create()` app-create transaction (no funding step), followed by `register()` on the Factory. The compiled
programs live in `smart_contracts/artifacts/` (generated, gitignored); the ARC-32/56 specs and the generated clients are tooling-only
and never go on-chain.

## The claim-tree design

Each pledge appends one leaf to the campaign's incremental tree:

`leaf = H(0x01 ‖ backer ‖ amount ‖ paymentTxId)` with `H = SHA-512/256` (the AVM `sha512_256` opcode — *not* `sha256`,
which is plain SHA-256).

The leaf binds the in-group payment (sender, amount, and transaction ID come from the confirmed payment, never from
caller-supplied arguments), so a leaf is non-transferable and self-authenticating. The contract stores only the single 32-byte
`root` plus the position count `N`; callers supply frontiers (for `pledge`) and paths (for spends) that the contract authenticates
against the stored root. Cancellations and refunds **null the leaf in place** (write `Z`, the 32 zero bytes); a second spend of the
same position — or a proof built against any older root — reconstructs a non-stored root and is rejected. The tree itself is the
anti-double-refund state.

## State

All state is global — **no boxes and no per-backer records**, so the campaign's storage (and its creator's capital) is constant
regardless of the backer count.

| Key | Type | Meaning |
| --- | --- | --- |
| `creator` | `Account` | Campaign creator; the only account allowed to `claim()` / `delete()` |
| `vault` | `Application` | The ClaimsVault app — holds pledges, pays out |
| `title` | `bytes` | Short campaign title, fixed at `create()` |
| `metadataUri` | `bytes` | URI of off-chain campaign metadata (ARC-3-style JSON blob) |
| `goal` | `uint64` | Funding target, in microAlgos |
| `deadline` | `uint64` | UNIX timestamp (seconds) after which the outcome is decided |
| `raised` | `uint64` | Live pledge total, in microAlgos (pledges minus cancellations/refunds) |
| `status` | `uint64` | `0` Open, `1` Failed, `2` Claimed |
| `root` | `bytes` | The single stored tree root (fold of the frontier peaks), or `Z` while `N == 0` |
| `n` | `uint64` | Positions ever appended; never decremented |

## State machine

```mermaid
stateDiagram-v2
    [*] --> Open: create()
    Open --> Open: pledge() — appends a leaf, ALGO to the vault
    Open --> Open: cancelPledge() — nulls the leaf, vault pays back
    Open --> Claimed: claim() — vault pays the creator; settlement recorded
    Open --> Failed: refund() — first refund flips the status; vault pays back
    Failed --> Failed: refund() — while the campaign app exists
    Failed --> [*]: delete() — vault records the settlement (settle)
    Claimed --> [*]: delete() — vault releases the box (notifyDelete)
    Open --> [*]: delete() — pristine or fully-cancelled; settle runs (no-op without a box)
    Failed --> Failed: vault.refund() — backers reclaim from the vault until the window closes
    Failed --> [*]: vault.finalize() — residual to the sweep target after the window (O(1))
```

## Settlement is pull-based

Nothing runs automatically on Algorand: smart contracts execute only when someone submits a transaction. The `deadline` is a timestamp
**guard**, not a trigger.

- **Successful campaign:** the creator calls `claim()`; the vault pays the full live total. No backer action is needed after success.
- **Failed campaign:** each backer refunds — through the campaign while it lives, or **directly from the vault after settlement**
  (creator-driven `delete()` → `settle`, or permissionless `settleOpen()` when the creator vanished). Refunds stay open for the vault's
  refund window (730 days by default), then `finalize()` sweeps any residual to the sweep target — disclosed at pledge time.
- **The backer's ALGO is never swept by anyone** before the window closes; every movement of funds is an explicit transaction submitted
  by a caller.

## Methods & guards

### `create(vault, title, metadataUri, goal, deadline)`

- `@abimethod({ onCreate: 'require' })` — only runs in the app-create transaction.
- Guards: must be app-create, `title` non-empty, `title`/`metadataUri` ≤ 128 bytes each (the AVM cap for a bytes global-state value),
  `goal > 0`, deadline in the future. Stores everything; `root = Z`, `n = 0`. Nothing is funded.

### `pledge(payment, frontier)`

- Normally grouped as `[Payment, Campaign.pledge, Vault.credit]` (one atomic group): the payment goes **to the vault**, this call
  appends the leaf, and `credit` records the inflow in the vault's box.
- Guards: before the deadline, `status == Open`, payment from the caller **to the vault**, `amount > 0`, caller is not the creator, and
  `frontier.length == 32·popcount(N)`.
- Authenticates the frontier with `fold` against the stored root (`N == 0` takes the empty-frontier branch), derives the leaf from the
  in-group payment, runs the merge cascade, stores the new root, `N + 1`, `raised += amount`. **Re-pledging is allowed** — each pledge
  appends a new leaf.
- Sizes its own opcode budget from the peak count (`ensureBudget`, spec §14); the caller funds it via fee pooling.

### `cancelPledge(k, amount, txid, path)` / `refund(k, amount, txid, path)`

- `cancelPledge`: before the deadline while `Open`. `refund`: after the deadline with `raised < goal`, materialising `Failed` on the
  first call. Otherwise identical — both delegate to `spendLeaf`.
- `spendLeaf` rebuilds the leaf from the caller + proof (never trusted), derives the expected path shape from `(N, k)` and asserts the
  blob length, verifies the path against the stored root, nulls the leaf, decrements `raised`, and inner-calls
  `vault.payBack(app, caller, amount)`. The path is one blob: `siblings ‖ top ‖ lower`.
- After `settleOpen`, the campaign path fails at the vault (box no longer `Open`) — backers use `vault.refund` with the same proofs.

### `claim()`

- Creator only, after the deadline, `raised >= goal`, and `status == Open` (prevents double payout).
- Sets `status = Claimed` and inner-calls `vault.payClaim(app)`. The vault pays the derived live total (`paidIn − paidOut`) to the
  creator and flips its box to `Claimed`, rejecting all later refunds.

### `delete()`

A guarded `@abimethod({ allowActions: 'DeleteApplication' })`, creator only:

- **Settled or empty only** — `status != Open`, or an open campaign with `raised == 0` (nothing live), or a failed-in-fact campaign
  (deadline passed, `raised < goal`) which is materialised here.
- **Claimed** — inner-calls `vault.notifyDelete(app)` (requires the box `Claimed` with inflows fully paid out), recovering its minimum
  balance to the pool in O(1).
- **Anything else** — inner-calls `vault.settle(app, root, N)`: a no-op when no box exists, an idempotent write of root/N/`Failed` plus
  the settlement timestamp otherwise. This unconditional settle is what keeps stray no-pledge inflows finalizable instead of stranded
  (a pristine campaign cannot see the vault box, so it cannot condition on it).
- Then closes the escrow to the creator (a zero-amount close — the escrow never holds funds).

## Vault interaction

Inner app calls use raw ARC-4 selectors (computed from the emitted ARC-56 signatures and pinned by selector-bytes tests):

| Selector | Call | Args |
| --- | --- | --- |
| `b0e0eedf` | `payBack` | `(appId uint64, backer address, amount uint64)` |
| `f8c4e0cb` | `payClaim` | `(appId uint64)` |
| `09200848` | `settle` | `(appId uint64, root byte[], n uint64)` |
| `87060e1d` | `notifyDelete` | `(appId uint64)` |

Two encoding rules for raw inner `appArgs` (learned the hard way — see Implementation notes):

- Static types (`uint64`, `address`) go raw (`itob`, address bytes).
- Dynamic `byte[]` (the settle `root`) must carry its ARC-4 uint16 length prefix — `prefixedBytes()` builds it. `address` needs none.

Every outer transaction that triggers inner vault calls declares the vault's campaign box in `boxReferences` and the vault app in
`appReferences`; first-touch `credit` additionally declares the Factory app plus its registration box (`'r' ‖ appId`) for the inner
`isRegistered` call. Inner calls to *oneself* are forbidden by consensus — opcode headroom comes from `ensureBudget` (OpUp creates),
never self-calls.

## Minimum balances

| Item | Amount | Who pays | Recovered |
| --- | --- | --- | --- |
| App sponsorship floor (on the creator's account) | ≈ 0.24 ALGO | Creator | `delete()` |
| Vault campaign box (65 bytes) | 32,100 µA | Platform (vault headroom) | `notifyDelete` / `finalize` |
| Factory registration box | 18,900 µA | Creator (deposit) | `unregister()` |

The creator's total is a small constant (≈ 0.26 ALGO with registration), fully recoverable in O(1) on **every** path. Backers lock no
minimum balance anywhere — no ASA opt-ins exist.

Measured fee totals per operation on LocalNet (each inner transaction costs its caller 1,000 µA via fee pooling; an OpUp iteration is
two inners, create + delete):

| Operation | Group fee | Breakdown |
| --- | --- | --- |
| `create` | 1,000 | app call |
| `register` | 2,000 | payment + app call |
| pledge group | 4,000 | payment + pledge call + credit call (extraFee headroom, always charged) |
| `cancelPledge` / campaign `refund` | 4,000 | app call + 1 OpUp iteration + inner `payBack` |
| vault `refund` | 4,000 | app call + 1 OpUp iteration + inner payment |
| `claim` | 3,000 | app call + inner `payClaim` + inner payment |
| `settleOpen` | 1,000 | app call, no inners |
| `finalize` | 2,000 / 1,000 | with / without residual payment |
| `delete` | 3,000 | app call + inner settle/notify + escrow close |
| `unregister` | 2,000 | app call + inner deposit-back (returns 18,900) |

OpUp iterations grow only with `log N`-class path lengths (spec §14); typical campaigns never leave the table above.

## Design decisions

1. **The leaf is the receipt.** Sender-, amount-, and payment-bound; caller-supplied proofs are untrusted input authenticated against the
   stored root.
2. **Single stored root + N.** No frontier state on-chain; no per-backer storage anywhere (campaign or vault).
3. **Null-in-place refunds.** No tombstone set, no bitmap — `Z` marks consumed leaves and the root simply evolves.
4. **The split escrow.** Backers' ALGO never enters the campaign escrow (which is never even funded), so no backer is ever on the
   creator's finalization path — every path finalizes in O(1).
5. **The vault derives payouts from per-campaign balance guards** (`amount ≤ paidIn − paidOut`), never from caller figures.
6. **`delete()` settles unconditionally (except claimed)** so pristine campaigns with stray inflows stay finalizable; `settle` no-ops
   when no box exists.
7. **Creators cannot self-pledge** — a self-pledge would fabricate the `raised` number and undermine the trust story.
8. **A credit without a pledge (or vice versa) strands only the deviator's funds** — every later outflow is capped at verified inflows
   (spec §17 #29).

## Known edge cases

1. **Stray no-pledge inflow to the vault** (direct `credit` without `pledge`). `paidIn` counts it but no leaf exists, so it can never be
   refunded — only swept by `finalize` after the window. Pristine `delete()` settles it (rather than stranding it) via the unconditional
   settle.
2. **Stray ALGO sent to the campaign escrow.** Rides along to the creator via `delete()`'s `closeRemainderTo`; never blocks a refund
   (the vault pays those).
3. **Campaign path after `settleOpen`.** Rejected at the vault (box not `Open`); the group reverts atomically with nothing half-written —
   backers retry through `vault.refund` with the same proofs.
4. **Deadline boundary.** Pledging/cancelling use `latestTimestamp < deadline` while claim/refund/settle use `>=`; at the exact `==` block
   pledging is closed and settlement is open.
5. **Overflow is impossible in practice.** All amounts are `uint64`; an overflow would need more ALGO than the total supply.

## Limits & bounds

| Dimension | Min | Max |
| --- | --- | --- |
| Backers | 0 | no contract cap |
| Pledges per backer | 0 | no per-backer cap (leaves accumulate) |
| Single pledge | 1 µA | none (`amount > 0`; bounded by the payer's balance) |
| Total raised | 0 | ALGO total supply (~10¹⁶ µA) |
| `goal` | 1 µA | none (uint64) |
| `deadline` | now + 1 second | none (uint64 seconds) |
| `title` | 1 byte | 128 bytes |
| `metadataUri` | 0 bytes | 128 bytes |
| Positions `N` | 0 | 2³² − 1 (app-args 2,048-byte ceiling on frontier/path blobs) |
| Campaign storage | 10 global-state keys | never grows |

## Implementation notes (PuyaTs gotchas, proven in this repo)

1. **Hash opcode.** `op.sha256` is plain SHA-256; the protocol hash is `op.sha512_256` (same cost). The LocalNet spike caught the mix-up
   differentially.
2. **Operators.** `+ - *` and comparisons are overloaded for `uint64`; `/ % >> << ^ & |` fall back to JS `number` semantics and poison any
   inferred variable — use `op.shr`/`op.shl`, annotate every derived numeric local explicitly, and test bit-twiddling offline.
3. **Loops must exit early.** A full 64-iteration scan blows the 700 budget on its own: `popcount` exits past the highest set bit,
   `pathLen` returns at the first missing level (both O(log N)); unreachable defensive tails carry `v8 ignore` for the 100% gate.
4. **Inner-call targets must be `Application`-typed state** (not bare `uint64` ids) — the offline emulator only resolves those; on-chain
   both work.
5. **Self-calls are forbidden** (reentrancy) — budget headroom comes from `ensureBudget` OpUp creates, sized from `(N, k)` by the contract
   itself; the caller funds it via `GroupCredit` fee pooling.
6. **Client groups need care.** The SDK composer does *not* dedupe: pass each transaction either explicitly (`addTransaction`) or by
   method-arg reference, never both. `send.delete` mis-encodes this contract's call — build delete groups with the manual composer.
7. **AppClient error attribution mixes frames**: the program name comes from the calling client while the app id comes from the fault —
   read the verbose `pc`/opcodes (or the source-mapped TEAL) rather than the short message.

## Client call patterns

- Pledge group `[pay, campaign.pledge, vault.credit]`: the payment object is referenced by the pledge call (which pulls it into the group
  ahead of the call); credit carries `appReferences: [factory]`, `boxReferences: [vault box, factory reg-box]`, `extraFee` headroom.
- Spends (`cancelPledge`/`refund`/`vault.refund`): single app call with the vault box declared, `extraFee` sized for one OpUp iteration at
  test-tree sizes (scale with `log N` per the table above).
- The confirmed payment TxID (group index 0) is the leaf's `txid` — read it from the send result, never precompute it (it commits to the
  group assignment).

## Testing

A full behavioral matrix lives in `contract.algo.spec.ts` — every method × every branch, with tree operations verified differentially
against the Python oracle (`../oracle.py`, driven with the mock payments' real `txnId`s). A LocalNet integration suite in
`contract.integration.test.ts` exercises full lifecycles end-to-end with µA-exact fund accounting: differential pledge/cancel/refund
sequences, forged/stale/double-spend rejections, claim + O(1) delete, settle-then-vault-refund, `settleOpen`, window enforcement, and
`sweepTarget` finalization. The vault's own matrix (pool isolation, zero-residual finalize, self-harm containment) lives in
`smart_contracts/claimsvault/`. See [`testing.md`](testing.md).

## References

Official Algorand docs backing the claims in this file (verify against these when in doubt):

- [Applications](https://dev.algorand.co/concepts/smart-contracts/apps/) — app lifecycle and the `DeleteApplication` transaction.
- [Box Storage](https://dev.algorand.co/concepts/smart-contracts/storage/box/) — box MBR, box deletion, app-deletion caveats.
- [Inner Transactions](https://dev.algorand.co/concepts/smart-contracts/inner-txn/) — app-account payments, inner app calls, fee pooling,
  and the reentrancy rule.
- [Transaction Types](https://dev.algorand.co/concepts/transactions/types/) — the payment `close` field and the application delete
  transaction.
- [Indexer REST API](https://dev.algorand.co/reference/rest-api/indexer/) — the `deleted` / `deleted-at-round` application fields.
