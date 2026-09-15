# AlgorArt Claim Tree Protocol — Specification v1

> **Status: specification (not implemented).** This document is the formal protocol definition for the redesign that replaces the
> Claim ASA with a trustless **incremental frontier-Merkle claim tree with in-place null-deletion**. It is written to be implemented by a
> second engineer without further architectural decisions. The language-independent reference model with property tests lives in
> [`claim-tree-protocol-reference.py`](claim-tree-protocol-reference.py) — it is the oracle for the contract test suite. No code in this
> document has been implemented; the repository is unchanged.
>
> Replaces, once implemented: the Claim ASA lifecycle in [`claim-asa-redesign.md`](claim-asa-redesign.md), the campaign contract internals
> in [`campaign.md`](campaign.md), and the affected rows of [`testing.md`](testing.md).

## 1. Repository and protocol verification

Verified against the repository at HEAD `1dbd708` and go-algorand `master` (`data/transactions/logic/opcodes.go`,
`TEAL_opcodes_v12.md`, `config/consensus.go`, `ledger/apply/application.go`, `ledger/apply/asset.go`, `basics/userBalance.go`).

### Current architecture (as implemented)

- **Campaign** (`smart_contracts/campaign/contract.algo.ts`) — one stateful app per campaign. Global state: `creator`, `vault`, `title`,
  `metadataUri`, `goal`, `deadline`, `raised`, `status`, `claimAsa`, `deposit`. Methods: `create`, `fund`, `attachClaimAsa`, `pledge`,
  `claim`, `refund`, `cancelPledge`, `closeOut`, `delete`. The escrow holds only the creator's 0.2 ALGO deposit plus the seeded Claim ASA
  supply; backers' ALGO goes to the vault; pledge mints claim units; `delete()` is O(1) on both paths.
- **ClaimsVault** (`smart_contracts/claimsvault/contract.algo.ts`) — permanent pooled escrow. State: `factory`, `asaOf`, `addressOf`,
  `creatorOf`, `settled` BoxMaps. Methods: `issueClaimAsa`, `seedSupply`, `payBack`, `payClaim`, `settle`, `refund`, `sweepClaimAsa`,
  `destroyClaimAsa`. Payout amounts are derived from ledger state (`total − vault holding − campaign holding`); payouts are gated on the
  campaign app caller; refunds work after campaign deletion.
- **Factory** (`smart_contracts/factory/contract.algo.ts`) — registration registry only: `owner`, `approvalHash`, `registered` BoxMap;
  `register` verifies the campaign program hash and the creator identity; refundable 18,900 µA deposit.
- **Transaction groups:** pledge `[Payment→vault, Campaign.pledge]`; refund `[axfer→vault, Campaign.refund]`; claim = single app call;
  delete = single app call with inner vault calls.
- **MBR (current):** creator ≈ 0.67 ALGO (recoverable O(1)); vault ≈ 147,100 µA per campaign parked at issuance, recoverable **only**
  after `sweepClaimAsa` per holder + `destroyClaimAsa` (O(N) on the success path — the failure this protocol removes); backer 100,000 µA
  per claim-ASA opt-in (backer-owned, reclaimed by `closeOut`).

### AVM facts relied on (verified)

| Fact | Value | Source |
| --- | --- | --- |
| `sha256` opcode | SHA-512/256, cost 35 | `opcodes.go` v2+ |
| Per-call opcode budget | 700, never raised | `consensus.go` v24 |
| Group budget pooling | 700 per app call in the group; inner app calls add 700 each to the shared pool | `consensus.go` v30 (`EnableAppCostPooling`); `eval.go` `NewAppEvalParams`/`NewInnerEvalParams` |
| `txn TxID` / `gtxn i TxID` | `[32]byte`, available without version gate (field 23) | `TEAL_opcodes_v12.md` |
| App args | 16 max; **2048 bytes total** | `consensus.go` (`MaxAppTotalArgLen` = 2048, v24) |
| Box | 2,500 + 400×(name+value) µA MBR; name ≤ 64 B, value ≤ 32 KB; 8 refs/call; 1,024 B IO budget per ref | docs, `consensus.go` v36, repo constants |
| App opt-in (local state) MBR | 100,000 + 25,000/byte-slice + 3,500/uint, on the **opted-in account**; app deletion does **not** release it | `userBalance.go`, `deleteApplication` |
| No history access | `block` = header fields only; no opcode reads past transactions or logs; no state-proof verification | `opcodes.go` |

## 2. Formal protocol definition

### Hash function

`H(x) = SHA-512/256(x)` — the AVM `sha256` opcode. `Z = 0x00 × 32` (32 zero bytes).

### Leaf

```text
leaf = H( 0x01 ‖ backer ‖ amount ‖ paymentTxId )
      backer      : 32 bytes — the pledger's account address (contract-derived: Txn.sender)
      amount      :  8 bytes — big-endian uint64 (contract-derived: payment.amount)
      paymentTxId : 32 bytes — the pledge payment's transaction ID (contract-derived: payment.txnId)
```

**Domain separation justification:** every other `H` application in the protocol combines two 32-byte node values (64-byte preimages)
or a peak fold (also 64-byte preimages). The 73-byte `0x01`-prefixed leaf preimage shares no length-prefix ambiguity with any of them,
so no adversary can mix leaf hashes into internal-node positions or vice versa. The single byte suffices: no two legitimate preimage
forms collide in length.

**Contract derivation, not caller copies:** the leaf is computed by the contract from the transaction itself — `Txn.sender` is the app
call sender, `payment.amount` and `payment.txnId` are read from the pledged payment in the same atomic group (the ABI argument is a
`gtxn.PaymentTxn` reference; `txn TxID` is readable in AVM — verified above). The caller never supplies the leaf or any of its
components at pledge time. `assert leaf ≠ Z` at append.

## 3. Canonical tree definition

The tree is a **left-filled binary Merkle tree over N positions**, where `N` = number of positions ever appended and is **never
decremented**.

- **Positions:** `0 … N−1`; position `i` holds a *leaf value* `v_i`, which is either a leaf (§2) or the consumed marker `Z`.
- **Nodes:** node `(l, i)` covers the aligned block `[i·2ˡ, (i+1)·2ˡ)` and exists iff `(i+1)·2ˡ ≤ N` (blocks are never partial — the
  rightmost partial blocks are represented by peaks, below). Leaf level: `(0, i) = v_i`. Internal: `(l, i) = H( (l−1, 2i) ‖ (l−1, 2i+1) )`.
- **Tree shape:** uniquely determined by `N` alone.
- **Peaks (frontier):** `N = Σ 2ˡ` over set bits. For every set bit `l` of `N` there is exactly one peak `f_l` at level `l`: the subtree
  root of the block `[((N>>l)−1)·2ˡ, ((N>>l)−1)·2ˡ + 2ˡ)` — i.e., the perfect subtree ending at position `N`. `f_0` is the newest
  trailing element; higher peaks are older, larger subtrees. Peak count `p = popcount(N)`.
- **Peak ordering:** ascending by level, `[f₀, f₁, …]`.
- **Fold (the single stored root):**

```text
fold([f₀ … f_{p−1}])  =  acc := f_{p−1};  for j = p−2 … 0:  acc := H(acc ‖ f_j)
```

The highest peak is always the left argument of every combine — this is what makes `fold` equal the natural root of the left-filled
tree. **Empty tree:** `Root(∅) = Z`, asserted while `N = 0`.

**Symbolic roots** (`l_i` = leaf value at position `i`):

| N | Root |
| --- | --- |
| 0 | `Z` |
| 1 | `l₀` |
| 2 | `H(l₀‖l₁)` |
| 3 | `H(H(l₀‖l₁)‖l₂)` |
| 4 | `H(H(l₀‖l₁)‖H(l₂‖l₃))` |
| 5 | `H(H(H(l₀‖l₁)‖H(l₂‖l₃))‖l₄)` |
| 6 | `H(H(H(l₀‖l₁)‖H(l₂‖l₃))‖H(l₄‖l₅))` |
| 7 | `H(H(H(l₀‖l₁)‖H(l₂‖l₃))‖H(H(l₄‖l₅)‖l₆))` |
| 8 | `H(H(H(l₀‖l₁)‖H(l₂‖l₃))‖H(H(l₄‖l₅)‖H(l₆‖l₇)))` |

All formulas in this document were validated symbolically and exhaustively (every N ≤ 12, every leaf pattern) by the reference model.

## 4. Frontier authentication and append

`pledge()` receives the frontier **from the caller** as a single byte string: the peak values in ascending level order, exactly
`p = popcount(N)` values, `32·p` bytes (length asserted against the contract's stored `N`).

1. **Payment checks** (see §9) — the payment is verified atomically in-group.
2. **Frontier authentication:** the contract computes `fold(frontier)` using the peak levels dictated by its **own stored `N`** and
   asserts equality with the **stored root**. Under SHA-512/256 collision resistance, the fold function has no computable alternative
   preimage: a different history would produce different peak values, and no two distinct peak tuples fold to the same root. The
   verified frontier is therefore *the* frontier of the committed tree.
3. **Merge cascade:** `g := leaf; l := 0; while bit l of N is set: g := H(f_l ‖ g); l += 1`. The consumed (older) peak is always the
   **left** child; the incoming node is the right child.
4. **Surviving peaks:** the peaks at levels `> l` survive unchanged; `g` becomes the new peak at level `l`.
5. **New root:** `fold([g] ‖ surviving peaks)`; `N' = N + 1`. Store `(root′, N′)`.

**Induction proof.** Invariant: `storedRoot = Root(v₀ … v_{N−1})` (the canonical root over the current leaf values).
*Base:* `N = 0, root = Z` ✓. *Step (append):* by hypothesis the stored root commits `v₀ … v_{N−1}`; the authenticated frontier is that
tree's peaks; the cascade is exactly the MMR append (`H(old-peak ‖ new)` preserves the left/right convention of §3), so
`fold(new peaks)` is by construction the canonical root over `v₀ … v_{N−1}, v_N` — verified exhaustively and by random testing against
naive tree construction. *Step (null):* §5. ∎

## 5. Nullification (refund)

The refund proof carries `(k, amount, paymentTxId, path)`. The contract:

1. Recomputes `leaf_k = H(0x01 ‖ Txn.sender ‖ amount ‖ paymentTxId)` — **derived from the caller and the proof**, never trusted.
2. Reconstructs the root from `leaf_k` along the path (§6) and asserts it equals the stored root.
3. Recomputes the root with `Z` in place of `leaf_k` and stores it; pays `amount`; `refundedTotal += amount`.

**Path structure** (derived by the contract from `(N, k)`): for `l = 0, 1, …` while the sibling node `(l, (k>>l)⊕1)` exists — i.e.
while `(((k>>l)⊕1)+1)·2ˡ ≤ N` — the sibling value appears in the path (ascending `l`). Let `r` be the first level where the sibling
does not exist; the node containing `k` at level `r` is the peak `f_r` (this is a property of the left-filled shape — validated
exhaustively). The path continues with: `top` — the **fold of all peaks at levels > r** (one 32-byte value; omitted when none exist) —
followed by the peaks at levels `< r` in ascending order (`c = popcount(N mod 2ʳ)` values). The expected path length
`r + c + e (e ∈ {0,1})` is asserted by the contract.

**Combine rule:** for the first `r` values, direction is bit `l` of `k` (`0` → `H(current ‖ sibling)`, `1` → `H(sibling ‖ current)`);
then `acc := H(top ‖ acc)` if `top` exists; then for each lower peak in **descending** order: `acc := H(acc ‖ peak)`.

### Proofs A–G

- **A. Validity.** `Root(v₀ … Z … v_{N−1})` is well-defined: `Z` is a leaf value; the combine recomputation over the unchanged
  siblings reproduces exactly the canonical root with `v_k := Z`. Verified symbolically and exhaustively (§15).
- **B. Append compatibility.** By induction (§4), each operation preserves the invariant, so after *any* sequence of nullifications the
  stored root is still the canonical root of the N-position tree; append (§4) needs only `(root, N)` and therefore composes with any
  null sequence. The reference model tests exactly the requested trace `append A, B, C; refund B; append D; refund A; append E;
  refund D; append F` and 100 randomized interleavings.
- **C. Arbitrary ordering.** The induction imposes no ordering on positions: `refund(7), refund(2), refund(91), refund(0)` all succeed
  provided each position is `< N` and not yet consumed.
- **D. Double refund.** After the first refund, position `k` holds `Z`. A second proof carries the genuine leaf `leaf_k ≠ Z`; its path
  reconstruction ends at the *previous* root, not the stored one → assertion fails. Deterministic rejection.
- **E. Amount binding.** `amount` is hashed into `leaf_k`; any modification produces a different leaf whose path reconstruction does not
  equal the stored root. The amount paid is exactly the amount committed by the authenticated leaf.
- **F. Sender binding.** The contract rebuilds `leaf_k` with `Txn.sender`; a leaf belonging to another backer would need a different
  preimage and fails the root check. The caller can only ever authenticate the leaf whose preimage contains their own address.
- **G. Transaction binding.** `paymentTxId` is part of the leaf preimage; it was read from the atomic group at pledge time, and any
  substitution at refund time breaks the leaf hash. (The contract does not need to *authenticate* the txid at refund time — the tree
  already did at pledge time.)

## 6. Frontier after deletions

After nullifications the frontier is **the canonical frontier of the current mutable value tree** — the same definition as §3, applied
to the current leaf values `(v_i ∈ {Z} ∪ leaves)`. Nulling position `k` changes exactly one frontier node: the peak containing `k`
(and, transitively, the root).

**Client/indexer reconstruction algorithm** (deterministic from public chain data):

1. Replay every pledge in (round, txn-index) order: each pledge app call's group contains the payment whose `(sender, amount, TxID)`
   are readable from the block; append `leaf = H(0x01 ‖ sender ‖ amount ‖ txid)` with the cascade of §4 — the frontier is maintained
   incrementally (O(popcount) work per pledge; no full tree needed).
2. Replay every nullifying call (cancel/refund/settle) in order: replace the leaf with `Z` at the given position, updating the nodes on
   its path.

Any sequence of such public events reconstructs the exact current frontier and root. A caller submits this frontier to `pledge()`; the
contract authenticates it against `(storedRoot, N)` with `fold` (§4) — the contract **never stores the frontier**. If the supplied
frontier is stale or fabricated, the fold check fails and the transaction is rejected (retry with fresh data).

## 7. Concurrency and stale proofs

Relied-upon consensus property: **Algorand applies transactions serially** — each transaction's execution observes all prior confirmed
state; a group is atomic (all-or-nothing). Two refunds constructed against the same root `R₀`:

- **A executes first** (`R₀ → R₁`), nulling leaf 10.
- **B's proof is against `R₀`.** Every leaf's authentication path includes the root; after any null, `R₁ ≠ R₀` and B's reconstruction
  lands on `R₀ ≠ R₁` → the assertion fails → **B is rejected atomically, nothing is written.** This holds for both overlapping and
  disjoint paths (the root is on every path). B's client must re-fetch the path (from the public tree state) and retry — an explicit,
  expected retry semantic, identical to stale-nonce handling.
- **Stale-root overwrite is impossible by construction:** the contract never writes a caller-supplied root; it writes only the root it
  recomputed from its own stored state plus a verified proof.
- **Refund vs append (during OPEN):** serialized; the append authenticates the frontier of the post-null tree (a stale frontier fails
  the fold check); the null verifies against the post-append root (a stale path fails). Whichever is second fails deterministically and
  retries.
- **Campaign deletion vs refund:** the settlement box is written atomically by `delete()` (via the inner `settle`); a refund racing it
  either executes before (against the campaign root, path `payBack`) or after (against the vault box) — both are valid; there is no
  interleaving in which a refund is lost.
- **Campaign deletion vs pledge:** the pledge group's inner `credit` requires the vault box to be `OPEN`; a settle/deletion that lands
  first flips the box → the pledge group reverts entirely.

## 8. Receipt design

A backer's proof data is **entirely reconstructable** from public chain history (pledge payment + app-call deltas are in the blocks;
positions, amounts, txids, and the tree are deterministic). The receipt is a *cache*, never a bearer secret.

- **Mandatory receipt data (recommended cache):** `campaignAppId (8) ‖ position k (8) ‖ amount (8) ‖ paymentTxId (32)` = 56 bytes.
- **Reconstructable:** the authentication path, the current tree/root, and `N` (campaign global-state delta at pledge time; the vault
  also stores `N` in the settlement box).
- **`N`-at-pledge-time is NOT part of the receipt** — the path structure is derived from `(k, N)` where `N` is the *current* stored
  value, which the client reads from on-chain state. (It was retained in an earlier draft out of caution; it is redundant.)
- **Cryptographically authenticated:** `(backer, amount, txid)` via the leaf hash; `k` via the path; the whole tree via the stored root.
  Nothing in the receipt is a secret; possession of the receipt data without control of the backer's address is worthless (§5-F).

## 9. Exact transaction protocol

Two contracts: **Campaign** (v2) and **ClaimsVault** (v2). Factory is unchanged. The vault holds all funds; the campaign escrow holds
**nothing** (no deposit, no asset — `fund()` is removed entirely).

### Campaign global state (v2)

`creator (Account)`, `vault (Application)`, `title (bytes)`, `metadataUri (bytes)`, `goal (uint64)`, `deadline (uint64)`,
`raised (uint64)`, `status (uint64)`, `root (bytes32)`, `N (uint64)`. Schema: 5 byte-slices + 5 uints.

### Vault global state and boxes

Global: `factory (uint64)`, `refundWindow (uint64)`, `sweepTarget (Account)`, `owner (Account)`.
Per campaign, one box, key = `c` ‖ appId (9 bytes), value (65 bytes):

```text
paidInOf   (8, BE) ‖ paidOutOf (8, BE) ‖ root (32) ‖ N (8, BE) ‖ settledAt (8, BE) ‖ status (1)
```

`status`: `0 = OPEN`, `1 = FAILED`, `2 = CLAIMED`. Box MBR = 2,500 + 400×(9+65) = **32,100 µA** (verified formula). No other
per-campaign state exists. There is **no ASA, no addressOf/asaOf/creatorOf mapping** — the vault authenticates the campaign caller as
`Txn.sender == app.address` (only the app's own program can spend as its account) plus Factory registration on first touch (see
`credit`).

### Pledge

Group: `[Payment (backer → vault, amount a, note optional), Campaign.pledge(payment, frontier)]`.

`Campaign.pledge` checks: deadline not passed; `status == OPEN`; `payment.receiver == vault.address`; `payment.sender == Txn.sender`;
`payment.amount > 0`; `Txn.sender != creator`; `frontier.length == 32·popcount(N)`. Computes
`leaf = H(0x01 ‖ sender ‖ amount ‖ payment.txnId)`; asserts `leaf ≠ Z`; authenticates the frontier (§4); updates `root, N`;
`raised += amount`. Emits two inner calls: (1) `self.reserve()` — a no-op that adds 700 to the pooled budget; (2)
`vault.credit(app, backer, amount)`.

`Vault.credit` checks: `Txn.sender == app.address`; if the box is absent: inner-call `factory.isRegistered(app)` (result must be
true); assert `status == OPEN`; **independently verify the payment**: scan the caller's group (`gtxn`) for a payment with
`sender == backer`, `receiver == vault`, `amount == amount` — assert found. Then `paidInOf += amount` (creating the box on first
pledge). The vault's `paidInOf` therefore counts only real payments into the vault — the "derived, not trusted" property of the
current design is preserved, per campaign.

### Cancel (pre-deadline withdrawal, while OPEN)

Group: `[Campaign.cancelPledge(k, amount, txid, path)]`. Checks: deadline not passed, `status == OPEN`, `k < N`, path length as
derived; verifies and nulls `k` (§5); `raised -= amount`; inner `vault.payBack(app, backer=Txn.sender, amount)`.

`Vault.payBack` checks: `Txn.sender == app.address`; box `status == OPEN`; `amount ≤ paidInOf − paidOutOf`; then `paidOutOf += amount`
and pays `backer`. (The vault-enforced balance guard is what keeps campaign bugs from draining other campaigns' funds — the pooled
vault's isolation invariant.)

### Refund, campaign alive (post-deadline, pre-delete; covers "creator vanished")

Group: `[Campaign.refund(k, amount, txid, path)]`. Checks: deadline passed; `raised < goal`; if `status == OPEN` set
`status = FAILED`; then `status == FAILED`; verify + null `k`; `raised -= amount`; inner `vault.payBack` (same guards). This path keeps
working forever as long as the campaign app exists, with no creator involvement.

### Refund, after settlement (campaign may be deleted)

Group: `[Vault.refund(app, k, amount, txid, path)]`. Checks: box exists, `status == FAILED`, `k < N`, refund window not expired
(§13), path length derived from `(N, k)`; rebuilds `leaf` from `(Txn.sender, amount, txid)`; verifies against the box's stored root;
nulls; asserts `amount ≤ paidInOf − paidOutOf`; `paidOutOf += amount`; pays `Txn.sender` from the pool. Runs entirely from vault-local
state — the campaign app is never read (it may be deleted; no `app_global_get_ex` on possibly-deleted apps is ever attempted).

### Successful settlement

`[Campaign.claim()]` (creator): deadline passed; `raised ≥ goal`; `status == OPEN`; set `CLAIMED`; inner `vault.payClaim(app)`.

`Vault.payClaim`: `Txn.sender == app.address`; box `status == OPEN`; `payout = paidInOf − paidOutOf` (**derived, not trusted** — equal
to the live pledge total because cancels were balanced); pay creator (`Txn.sender` is the campaign app… the recipient is
`app.creator`, read via foreign app global state); `paidOutOf += payout`; `status = CLAIMED`.

`[Campaign.delete()]` (creator): requires `status == CLAIMED` (or `FAILED`, or `raised == 0`); inner `vault.notifyDelete(app)` which
asserts `status == CLAIMED` and `paidInOf == paidOutOf`, then deletes the box (recovering the 32,100 µA) — **O(1), vault parks nothing
for successful campaigns**. Creator then `factory.unregister(app)`.

### Failed settlement

Either path, converging on the same box state:

- `[Campaign.delete()]` on a failed campaign (creator): inner `vault.settle(app, root, N)` — asserts `Txn.sender == app.address`; if
  box `status == OPEN`: write `root, N, settledAt = latestTimestamp, status = FAILED`; if already `FAILED`: no-op.
- `[Vault.settleOpen(app)]` (**permissionless** — the "creator vanished" case): asserts box `status == OPEN`; reads the campaign app's
  foreign global state (`status`, `root`, `N`, `raised`, `goal`, `deadline` — the app still exists); asserts deadline passed and
  `raised < goal`; writes `root, N, settledAt = now, status = FAILED`. After this, campaign-driven `payBack` is rejected (box not
  OPEN) and all refunds flow through the vault.

Then: refunds per §9 until the window closes (§13); then `[Vault.finalize(app)]` (permissionless): asserts `status == FAILED` and
`latestTimestamp ≥ settledAt + refundWindow`; pays `paidInOf − paidOutOf` to `sweepTarget`; deletes the box. **O(1).**

### Cross-campaign note

Every inner call names its own app id; the `Txn.sender == app.address` check makes cross-campaign calls impossible (an app account
acts only through its own program; app addresses are distinct).

## 10. State layout

Exactly as §9: campaign = 10 global slots (2 new: `root`, `N`; `claimAsa` and `deposit` removed); vault = one 65-byte box per campaign
(live and failed; deleted on claim-finalization or finalize). **No local state, no ASA, no per-backer storage anywhere.** Campaign
account balance: 0 (never funded). MBR: creator = app creation (100,000) + schema (5×25,000 + 5×3,500 = 142,500) ≈ 0.24 ALGO, fully
recovered at `delete()`; vault = 32,100 µA per live/failed campaign, recovered via `notifyDelete`/`finalize`; backer = **0**.

## 11. Accounting and solvency

Invariants (all enforced by the contract, none rely on the indexer):

1. `paidInOf` increments only with a payment the vault itself verified in-group (§9 `credit`) → `paidInOf` = total µA this campaign
   actually paid into the pool.
2. `paidOutOf` increments only via `payBack` (cancels/live refunds), `payClaim`, and vault refunds, each guarded by
   `amount ≤ paidInOf − paidOutOf` → `paidOutOf ≤ paidInOf` at every instant.
3. Every refund pays exactly the amount committed by the authenticated leaf (§5-E), and every leaf amount was part of a verified
   payment → `refunds + cancels + claim ≤ paidInOf`.
4. `finalize` pays exactly `paidInOf − paidOutOf` → **total outflows = total inflows per campaign**:
   `paidInOf = cancels + liveRefunds + vaultRefunds + (claim payout) + (finalize residual)`.
5. **Pooled isolation:** all outflows are per-campaign capped by the per-campaign balance guard (2), so campaign A's funds can never
   pay campaign B — enforced at the vault, not by code review, exactly as the current design's unit-conservation derivation does.

## 12. State machines

### Campaign app

```text
OPEN ──pledge──▶ OPEN            (deadline not passed)
OPEN ──cancelPledge──▶ OPEN      (nulls a leaf; raised −= amount)
OPEN ──refund (deadline passed, raised < goal)──▶ FAILED
OPEN ──claim (deadline passed, raised ≥ goal)──▶ CLAIMED
CLAIMED ──delete──▶ (deleted)    (requires CLAIMED)
FAILED ──delete──▶ (deleted)     (inner vault.settle)
OPEN with raised == 0 ──delete──▶ (deleted)   (abandoned)
```

Illegal: pledge/cancel after deadline or when status ≠ OPEN; claim before deadline or below goal; delete with live pledges
(`raised > 0` and status == OPEN); refund when `raised ≥ goal`; double claim/delete (app is gone).

### Vault box

```text
absent ──credit──▶ OPEN          (first pledge; Factory check on creation)
OPEN ──credit/payBack──▶ OPEN
OPEN ──payClaim──▶ CLAIMED ──notifyDelete──▶ absent
OPEN ──settle (campaign delete)──▶ FAILED
OPEN ──settleOpen (permissionless)──▶ FAILED
FAILED ──refund──▶ FAILED        (window open; paidOutOf grows)
FAILED ──finalize──▶ absent      (window closed; residual to sweepTarget)
```

Illegal: credit/payBack on a FAILED/CLAIMED box; refund on OPEN/CLAIMED/absent boxes or after the window; finalize on OPEN/CLAIMED
or before the window; double settle (idempotent no-op); double finalize (box absent → reject).

### Edge cases

- **Zero pledges:** box may be absent; `delete()` on `raised == 0` succeeds; `settleOpen` creates a box with `N = 0, root = Z` so
  `finalize` can clean the (zero) residual — no stranded state.
- **One pledge:** tree of one leaf; refund path length 0; works.
- **Last pledge immediately before deadline:** pledge group lands while `latestTimestamp < deadline` (consensus serialization); it is
  either included or not; no partial state.
- **Refund immediately before deadline:** takes the `cancelPledge` path (OPEN); identical null mechanics.
- **Delete immediately after deadline:** below goal → `settle`; above goal with `raised > 0` and OPEN → rejected (must claim first).
- **Creator disappears on a failed campaign:** `settleOpen` (permissionless) opens vault refunds forever after.
- **Backer/all backers disappear:** nothing waits on them (§10 of the adversarial matrix in the reference model docstring);
  `finalize` sweeps the residual O(1).
- **Creation followed by abandonment:** `raised == 0` delete path; no box; nothing parked anywhere.
- **Repeated finalization / settlement:** absent-box or idempotence guards above.

## 13. Refund window decision

**Option A — refunds forever.** The 32,100 µA anchor box per failed campaign is retained indefinitely, and the residual
`paidInOf − paidOutOf` stays in the pool forever. This fails requirement B in its strict letter (the box is protocol capital whose
recovery is blocked by any single never-refunding backer) — by a constant, but still a violation, and it leaves an ever-growing
liability on the pool.

**Option B — bounded refund window (recommended).** `refundWindow` is a vault-global constant (recommended: 730 days) set at vault
creation, immutable. Refunds are accepted while `latestTimestamp < settledAt + refundWindow`. Afterwards `finalize()` is
permissionless and O(1): the residual `paidInOf − paidOutOf` is paid to `sweepTarget` (the platform treasury, set at vault creation).

Requirement impact: **A** — fully satisfied within a generous, publicly-known window; the window is visible in the vault state from
day one and disclosed in the UI at pledge time, so it is part of the pledge contract, not a hidden rule. **B** — strictly satisfied:
every protocol resource (the box) and every liability (the residual) has a time-bounded, backer-independent recovery path; recovery
is one transaction. **C/D/E/F** — unaffected. Economic acceptability of the sweep: the residual represents backers who, over the full
window, never exercised a right they were offered at pledge time; the alternative (Option A) keeps their funds inert forever, which
benefits no one; Kickstarter's own failed-campaign model returns nothing at all without a creator-initiated process. If the platform
wants zero self-enrichment optics, `sweepTarget` can be a documented community fund — a governance decision, not a protocol change.

**Recommendation: Option B.**

## 14. Opcode and resource analysis

Derived from the verified reference model (not estimates):

| N | popcount(N) | pledge `H` calls (2·popcount) | worst-case refund path length | refund `H` calls (2·path+1) |
| --- | --- | --- | --- | --- |
| 1 | 1 | 2 | 0 | 1 |
| 10 | 2 | 4 | 4 | 9 |
| 100 | 3 | 6 | 8 | 17 |
| 1,000 | 6 | 12 | 14 | 29 |
| 10,000 | 5 | 10 | 17 | 35 |
| 65,535 (2¹⁶−1) | 16 | 32 | 30 | 61 |
| 65,536 (2¹⁶) | 1 | 2 | 16 | 33 |
| 100,000 | 6 | 12 | 21 | 43 |
| 131,071 (2¹⁷−1) | 17 | 34 | 32 | 65 |
| 131,072 (2¹⁷) | 1 | 2 | 17 | 35 |
| 1,000,000 | 7 | 14 | 25 | 51 |

Worst case for pledge is `N = 2ᵏ−1` (maximal popcount); worst case for refund is a leaf at position 0 of `N = 2ᵏ−1`
(path = `(k−1) + (k−1) = 2k−2`).

Budget model: `ops = H_calls × 35 + ~150` (ABI decode, box access, asserts, inner-call emission, payment scan). Available pool =
`700 × (top-level app calls + inner app calls)` under v30+ pooling (inner calls each add 700 — verified in `eval.go`). Required
self-calls (`ceil(ops/700) − 1` additional inner no-op calls):

- **Pledge** (group: 1 app call; 2 inner calls → pool 2,100): N=10,000 → 10·35+150 = 500 ✓ (pooling headroom large); worst realistic
  N=131,071 → 34·35+150 = 1,340 ✓. Only `N ≥ 2²⁰−1`-class trees need a third self-call.
- **Refund** (1 app call; self-calls as needed): N=1,000 → 1,165 → 1 self-call (1,400) ✓; N=10,000 → 1,375 ✓ 1; N=131,071 →
  2,425 → 3 self-calls (2,800) ✓; N=1,000,000 → 1,935 → 2 ✓.

Resource ceilings (hard limits, not Big-O):

- **Arguments:** refund args `appId(8) ‖ k(8) ‖ amount(8) ‖ txid(34) ‖ path(2+32·pathLen)`; total ≤ 2,048 B ⇒ pathLen ≤ 62 ⇒
  **N ≤ 2³²−1** (4.29 billion backers). Pledge frontier: `32·p + ~20` B ⇒ p ≤ 62 ⇒ N ≤ 2³²−1.
- **Box IO:** refund reads+writes one 65-byte box (1 ref → 1,024 B budget) ✓; `credit` writes the same box ✓.
- **Group size:** 2 top-level transactions (limit 16); ≤ 4 inner transactions (limit 256) ✓.
- **Stack:** values ≤ 32 B each during hashing (leaf preimage 73 B once); depth < 20 ✓.
- Fees: each inner self-call ≈ +1,000 µA (or drawn from the outer fee credit); total pledge fee ≈ 2–3× minimum, refund ≈ 2–4× — flat,
  independent of N.

## 15. Reference implementation

[`claim-tree-protocol-reference.py`](claim-tree-protocol-reference.py) — language-independent (Python 3, stdlib only), implements
`leaf`, `build_nodes`, `peaks`, `fold`, `root_of`, `append`, `path_of`, `verify`, `null`, and runs these property tests:

- fold == naive tree root, N = 1..299;
- append == naive root over 500 random append sequences;
- **exhaustive** verification + full null-sequences + double-null rejection for **every** leaf pattern at every N ≤ 12;
- randomized verify/arbitrary-null-order/double-null at N ∈ {13, 31, 63, 64, 100, 255, 256, 1000};
- 100 random mixed append/null sequences (the append-after-null invariant);
- stale-proof rejection; amount/txid/sender binding; the exact `2·popcount(N)` pledge-cost identity;
- worst-case path-length table (reproducing §14).

## 16. Differential testing plan

The contract test suite must, for every operation sequence (thousands of randomized `append/null` interleavings, all boundary N, the
traces from §5-B and §10 of the adversarial matrix): assert

```text
reference_root == onchain_root
reference_N    == onchain_N
reference_raised == onchain_raised (campaign paths)
reference_paidInOf/paidOutOf == vault box values
```

plus negative differentials: every proof the reference model rejects (stale, forged, double, wrong-amount, wrong-sender, wrong-k)
must be rejected by the contract with the same result. The simulator tests run the full sequences; the LocalNet integration tests run
the end-to-end groups of §9 (pledge, cancel, live refund, settleOpen, post-delete refund, finalize, claim/delete/notifyDelete) against
real consensus, including the races of §7.

## 17. Adversarial security analysis

| # | Attack | Why it fails | Layer |
| --- | --- | --- | --- |
| 1 | Forged leaf | leaves are created only by `pledge()`, contract-computed from the verified payment | app checks + AVM |
| 2 | Forged amount | amount is hashed into the leaf; modification breaks root verification | SHA-512/256 |
| 3 | Forged sender | leaf preimage binds `Txn.sender` | app checks + SHA |
| 4 | Forged TxID | txid committed in the leaf at pledge time | SHA |
| 5 | Forged position | path is verified against the stored root at exactly position k | SHA |
| 6 | Forged Merkle path | sibling tuple must reconstruct the stored root | SHA |
| 7 | Forged frontier | fold(frontier) must equal the stored root | SHA |
| 8 | Second refund | position holds `Z` after the first refund; re-proof fails | SHA + AVM state |
| 9 | Refund of another's pledge | leaf binds sender | app checks + SHA |
| 10 | Stale proof | rejected against the mutated root (§7) | AVM serialization |
| 11 | Stale frontier | fold ≠ current root | SHA |
| 12 | Cross-campaign proof | box is keyed by app id; root is campaign-specific | app checks |
| 13 | Cross-campaign TxID | the txid alone proves nothing; the tree it hashes into is campaign-specific | SHA |
| 14 | Malformed path | path length is asserted from (N, k) | app checks |
| 15 | Path-length manipulation | length check above; mis-sized paths are structurally rejected | app checks |
| 16 | `Z` as forged leaf | `leaf ≠ Z` asserted at append; a `Z` "leaf" fails verification | app checks + SHA |
| 17 | Hash collision | SHA-512/256 collision resistance (the chain's own assumption) | SHA |
| 18 | Second-preimage on nodes | a replacement sibling must fold to the stored root | SHA |
| 19 | Integer overflow | amounts are uint64 with `amount ≤ paidInOf − paidOutOf` and AVM's wrapping-free arithmetic; `paidInOf` counts real payments | AVM + app checks |
| 20 | Accounting overflow | the balance guard makes over-pay impossible regardless of campaign bugs | app checks |
| 21 | Pooled vault insolvency | per-campaign guard: outflows ≤ that campaign's verified inflows | app checks |
| 22 | Malicious creator | cannot touch `paidInOf`/`paidOutOf` or the root; claim pays only the derived balance; delete cannot steal pledges (`raised > 0` guard) | app checks |
| 23 | Malicious backer | all refund powers reduce to proving their own committed leaf | SHA + app checks |
| 24 | Abandoned campaign | `raised == 0` delete; `settleOpen`; no stranded state | app checks |
| 25 | Deletion race | atomic groups; box state transitions are asserted, never blind-written | AVM atomicity |
| 26 | Finalize race | window + status assertions; absent-box reject | app checks |
| 27 | Repeated finalize | box absent after first | app checks |
| 28 | Malicious indexer data | the indexer is never trusted: every supplied structure (frontier, path) is authenticated by the contract against on-chain state; wrong indexer data only causes a rejected transaction and a retry | SHA + app checks |

## 18. Six-requirement scorecard

| Requirement | Status | Proof |
| --- | --- | --- |
| A — Backer-controlled refund | ✓ | Self-service `refund`/`cancelPledge` from wallet alone; works after campaign deletion and after creator disappearance (`settleOpen`); no creator/platform processing exists on any refund path. Satisfied **within the refund window** under Option B. |
| B — Complete bounded finalization | ✓ with Option B | Protocol resources per campaign = one 32,100 µA box; recovered by `notifyDelete` (claimed) or `finalize` (failed, time-gated) — one transaction, independent of N and of any backer. Without the window (Option A), fails by a constant. |
| C — No O(N) platform operations | ✓ | No platform operation is per-backer anywhere; frontiers/proofs are computed by backers' own clients and *verified* by the contract. |
| D — Very high scalability | ✓ | Zero per-backer on-chain structures (no ASA, no boxes-per-backer, no local state, no bitmap). Per-campaign state is constant (10 global slots + one box). Single-call refunds to N ≈ 1,000; pooled-budget refunds to N ≈ 131k with 3 self-calls; argument ceiling N ≤ 2³²−1. |
| E — Minimal creator capital | ✓ | ≈ 0.24 ALGO (app + schema MBR on the creator's own account), fully recovered at `delete()`; **no escrow deposit at all** (`fund()` removed). |
| F — Zero backer action after success | ✓ | Backers hold nothing on-chain after success: no ASA, no opt-in, no local state, nothing to close, sweep, or destroy. 100% disappearance of backers leaves zero residue. |

## 19. Verdict

## GO

The Incremental Frontier-Merkle with In-Place Null-Deletion is formally coherent: append and arbitrary nullification compose by a
single induction invariant (validated exhaustively for N ≤ 12 and randomized to N = 1,000 in the reference model), the contract is the
sole committer (no auditor, no oracle, no trusted list), all security reduces to SHA-512/256 collision resistance plus the checks of
§17, and the resource model (§14) holds within current AVM limits for every realistic campaign size. Requirements A–F hold as scored
in §18, with the refund window (Option B) being the one explicit, documented condition attached to A and B.

The implementation must follow §§2–12 verbatim, treat `claim-tree-protocol-reference.py` as the oracle, and carry the differential
test plan of §16 before any deployment.
