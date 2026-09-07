# Commitment redesign (Merkle refunds)

> **Planned — not yet implemented.** Replaces the per-backer pledge box with an
> on-chain incremental Merkle tree, so refunds and app deletion scale to large
> backer counts and the box-MBR residue disappears. This doc is the spec;
> nothing here is code until it lands.
>
> Contract internals today: [`campaign.md`](campaign.md). Backend/archival:
> [`architecture.md`](architecture.md). Roadmap: [`roadmap.md`](roadmap.md).

## The problem with per-backer boxes

Today each backer gets one `pledges` box. Three costs follow from that:

1. **Box MBR residue.** Each box locks ≈ 0.0189 ALGO in the escrow
   (`2500 + 400 × (33 + 8)` µA). At 100k backers that is ≈ 1,890 ALGO locked,
   and it survives `claim()` because `claim()` only pays `balance − minBalance`.
2. **Delete is blocked.** Boxes must be deleted one by one (at most ~8 per
   app call), so the creator cannot delete the app until every box is gone, and
   a claimed campaign's residue can only be recovered by a manual sweep loop.
3. **O(N) cleanup.** Full drain costs O(N) transactions no matter what.

The redesign eliminates per-backer on-chain state, leaving only a 32-byte root,
the incremental tree's frontier, and a 1-bit-per-backer spent bitmap.

## The design

The contract maintains an **incremental Merkle tree** on-chain: each pledge
appends a leaf `(address, amount)` and updates the root in O(log N) via a stored
frontier. It stores the **root** (32 bytes, global state) and a **spent bitmap**
(one bit per leaf index). Per-backer data still lives off-chain (indexer /
backend) and is reconstructed when a proof is needed.

On a failed campaign a backer proves their pledge with a **Merkle proof** against
the root; the contract verifies the proof, checks the spent bitmap to stop
double-spending, and pays out. On a funded campaign the creator just claims the
whole balance — nothing is stranded and `delete()` is trivial.

Per-backer state compresses from ~41 bytes (box key + value) to **1 bit**, a
~300x MBR reduction. What it does *not* change: refunds remain pull-based — each
backer still submits one transaction. That is correct, not a flaw: a contract
cannot push funds to an arbitrary set of accounts without iterating them.

Because the tree is computed on-chain, there is no operator to trust and no
`finalize` step: the root is correct by construction, and `cancelPledge` remains
possible (a backer proves a leaf against the live root and marks it spent).

## Contract surface

### State

Everything in [`campaign.md`](campaign.md) today, minus the `pledges` box, plus:

| Key | Type | Meaning |
| --- | --- | --- |
| `root` | `bytes` (32) | Merkle root over all `(address, amount)` leaves, updated on every pledge/cancel |
| `frontier` | `Box` | The MMR frontier: completed-subtree roots, `h + 1` × 32 bytes |
| `spent` | `BoxMap<uint64, bytes>` | Sharded nullifier bitmap, one bit per leaf index |

### Methods

**`create(title, metadataUri, goal, deadline)`** — unchanged.

**`pledge(payment)`** — guards unchanged, but instead of writing a box it appends
a leaf `(Txn.sender, amount)` to the incremental tree, updating `root` and the
`frontier` box, and `raised += amount`. Side benefit: no box MBR, so the escrow's
`minBalance` drops to the 0.1 ALGO base (verify the exact first-pledge minimum on
LocalNet — it should fall from 0.1189 ALGO to ~0.1 ALGO).

**`cancelPledge(siblings: bytes[], index: uint64, amount: uint64)`** — backer
only, before the deadline. Verifies the proof against the live `root`, checks the
`spent` bit is `0`, sets it, decrements `raised` by `amount`, and pays `amount`
back. Cancellation is a spent marker, not a deletion — the leaf stays in the tree
but is dead. This preserves today's withdraw-before-deadline behavior.

**`refund(siblings: bytes[], index: uint64, amount: uint64)`** — backer only,
after the deadline when `raised < goal`. Materializes `status = Failed` on the
first call (same pattern as today). Verifies the proof, checks and sets the
`spent` bit, pays `amount` to `Txn.sender`. The shared `spent` bitmap is what
makes a cancelled leaf non-refundable and a refunded leaf non-cancellable.

**`claim()`** — unchanged. On success the escrow holds only pledges + the 0.1
base, so `balance − minBalance` ≈ 100% of pledges.

**`delete()`** — `DeleteApplication`, creator-only, `status != Open`, and
`escrowBalance() == 0`. No `backers` argument, no box loop. `CloseRemainderTo:
creator` returns just the 0.1 base. The `escrowBalance() == 0` guard stops the
creator from sweeping un-refunded money on a failed campaign.

### The incremental tree

A **fixed-height padded Merkle tree**: `h` is fixed at deploy (`h = 15` → 32,768
leaf slots). Leaves fill slots `0..N−1` in order; slots beyond `N` are a
domain-separated empty leaf. The root is the balanced hash over all `2^h` slots,
so every proof is exactly `h` siblings and there is no "promote the odd node"
edge case. Empty-subtree roots are hardcoded constants:

- `EMPTY[0] = sha256(b'')` — distinct from a real leaf (which hashes 40 bytes:
  32-byte address + 8-byte amount).
- `EMPTY[k] = sha256(EMPTY[k-1] || EMPTY[k-1])`.

Appending is O(h): the contract keeps the completed-subtree roots (an MMR
frontier) in a single `Box` and recomputes the empty-padded fold of the peaks.
`h` and the `EMPTY[k]` constants are fixed at deploy.

#### Why `sha256` and `h = 15`

A single app call has an opcode budget of 700 cost units, and `sha512_256` costs
45 while `sha256` costs 35 (see the
[AVM opcodes reference](https://developer.algorand.org/docs/get-details/dapps/avm/teal/opcodes/)).
A pledge (append + fold) and a refund (proof verify) are each `h + 1` hashes, so
at `h = 15` that is `16 × 35 = 560` cost — comfortably inside the budget with
room for box I/O and the payout. A binary tree cannot scale much higher within
this budget (`h = 19` would be 700 with nothing left over); a fanout-4/8 tree
would raise capacity if it is ever needed.

### Proof format

- Leaf at slot `i`: `leaf = sha256(address_bytes(32) || uint64_be(amount))`.
- Internal: `node = sha256(left(32) || right(32))`.
- A proof is exactly `h` siblings; direction at level `j` is bit `j` of `i`
  (0 = left child, 1 = right child). Empty subtrees appear in the proof as their
  precomputed `EMPTY[j]` constant, so the verifier needs no special case.

```text
node = sha256(sender || itob(amount))
for i in 0 ..< siblings.length:
    node = ((index >> i) & 1) == 0
        ? sha256(node || siblings[i])
        : sha256(siblings[i] || node)
assert(node == root)
```

With `h = 15`, a proof is `15 × 32 = 480` bytes — well within the 2048-byte
argument limit, and 15 hash ops is well within the 700-opcode budget.

### Spent bitmap (nullifier)

`index` doubles as the bitmap bit. Shard as `spent[index >> 13]` (8192 backers
per 1024-byte chunk, staying under the 2 KB box I/O budget). Read byte → check
bit → set bit → write byte. ≈ 5,100 µA total MBR for 100k backers. Set by both
`cancelPledge` and `refund`; the contract reads it on both paths.

## Re-pledge and live-leaf semantics

**Decision: one leaf per pledge (append-only).** A backer who pledges twice gets
two leaves; there is no on-chain accumulation. `raised` is the global sum of live
(not-spent) leaves, and a backer's individual total is the sum of their live
leaves, computed off-chain for the UI. `cancelPledge`/`refund` target one leaf
index, so cancelling everything costs one call (and one fee) per leaf — the fee
scales with pledge transactions, not backers, which is accepted as negligible
(≈ 0.002 ALGO per call).

## Backend surface

The backend is now convenience-only — it never publishes anything the contract
trusts (the root is computed on-chain):

1. **Catalog** — browse/detail for ended campaigns (unchanged, see
   [`architecture.md`](architecture.md)).
2. **`GET /api/campaigns/:appId/proof?address=…`** → `{ index, siblings, amount }`
   for the refund/cancel UI. A wrong proof is harmless — the contract rejects
   it — and a missing backend is survivable (a backer can reconstruct the tree
   from the indexer).

## Build order

1. **Refund machinery first.** `refund()` proof-verification loop, the spent
   bitmap, `claim()`, and `delete()`, tested against a hardcoded root. This
   proves the pipeline before the tree exists.
2. **The tree in plain TypeScript.** Implement the incremental tree as a normal
   TS module, unit-test against known Merkle vectors and property-test it
   (random inserts, cancel/re-pledge, odd leaf counts).
3. **Port to `.algo.ts`** and wire into `pledge()`/`cancelPledge()`, then run the
   full LocalNet lifecycle.

The tree math is where the subtle bugs live; a reference implementation to diff
against is how they get caught before any money is involved.

## Tooling to adopt

The redesign should also stop underusing the Algorand toolchain. These are worth
adding and are listed here so they land in the same change set:

- **`emit` events** — structured on-chain events the backend watcher consumes
  instead of scraping raw transactions (what makes the backend "real").
- **`@readonly` ABI methods** — free on-chain reads via `simulate` for the
  frontend.
- **Native hash opcodes** — `sha256` (chosen over `sha512_256` for its lower
  opcode cost, see above). See the
  [AVM opcodes reference](https://developer.algorand.org/docs/get-details/dapps/avm/teal/opcodes/).
- **Publishable ARC-56 spec** — the generated spec is the interface; publish it.

Explicitly **not** worth chasing (gold-plating): re-keying, state proofs, ASAs,
NFTs, and box streaming — none of them are relevant to a crowdfunding escrow.

## Open questions / verify on LocalNet

- Exact first-pledge minimum with no boxes (should be ~0.1 ALGO).
- The `sha256` + `bytes[]` proof loop compiles within the opcode budget (560 cost
  measured in the reference; verify the compiled TEAL stays under 700).
- Bitmap box I/O at the shard boundary.

## References

- [AVM opcodes](https://developer.algorand.org/docs/get-details/dapps/avm/teal/opcodes/) —
  `sha256`, `sha512_256`.
- [Box Storage](https://dev.algorand.co/concepts/smart-contracts/storage/box/) —
  box MBR formula and per-key deletion.
- [Applications](https://dev.algorand.co/concepts/smart-contracts/apps/) — app
  lifecycle and `DeleteApplication`.
- [Indexer REST API](https://dev.algorand.co/reference/rest-api/indexer/) —
  pledge-history reconstruction for tree building.
