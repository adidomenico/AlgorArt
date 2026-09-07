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
| `frontier` | `Box` | The incremental tree's frontier (the right spine; ~17 × 32 bytes at 100k leaves) |
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

Append-only Merkle tree: leaves are added left-to-right, and the root updates by
walking the frontier (the set of right-spine nodes). Append-only is sufficient —
we never need proofs-of-non-membership — so a sorted tree is not required. The
frontier lives in a single `Box` (~17 × 32 bytes at 100k leaves, well under the
2 KB I/O budget).

### Proof format

- Leaf: `leaf = sha512_256(address_bytes(32) || uint64_be(amount))`.
- Internal: `node = sha512_256(left(32) || right(32))`.
- `index` is the leaf position; direction at level `i` is bit `i` of `index`
  (0 = left child, 1 = right child) — no separate direction mask needed.

```text
node = sha512_256(sender || itob(amount))
for i in 0 ..< siblings.length:
    node = ((index >> i) & 1) == 0
        ? sha512_256(node || siblings[i])
        : sha512_256(siblings[i] || node)
assert(node == root)
```

At 100k backers, `siblings` ≈ 17 × 32 bytes ≈ 544 bytes — within the 2048-byte
argument limit, and ~17 hash ops is trivial for the 700-opcode budget.

### Spent bitmap (nullifier)

`index` doubles as the bitmap bit. Shard as `spent[index >> 13]` (8192 backers
per 1024-byte chunk, staying under the 2 KB box I/O budget). Read byte → check
bit → set bit → write byte. ≈ 5,100 µA total MBR for 100k backers. Set by both
`cancelPledge` and `refund`; the contract reads it on both paths.

## Re-pledge and live-leaf semantics

Each pledge appends one leaf; a backer who pledges twice ends up with two leaves.
There is no per-backer accumulation on-chain: `raised` is the global sum of live
(not-spent) leaves, and a backer's individual total is the sum of their live
leaves, computed off-chain for the UI. `cancelPledge`/`refund` target a specific
leaf index.

This is the one decision to lock **before** coding: the exact leaf identity (one
leaf per pledge vs. an "accumulate by spending the old leaf and appending a new
one" model) and the resulting semantics for `raised`, cancel, and the
backer-facing total. The one-leaf-per-pledge model is the simplest; accumulating
requires the backer to prove their old leaf on re-pledge and is a possible later
refinement.

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
- **Native hash opcodes** — `sha512_256` / `sha256` (required for the Merkle
  tree; also the "professional crypto" flex). See the
  [AVM opcodes reference](https://developer.algorand.org/docs/get-details/dapps/avm/teal/opcodes/).
- **Publishable ARC-56 spec** — the generated spec is the interface; publish it.

Explicitly **not** worth chasing (gold-plating): re-keying, state proofs, ASAs,
NFTs, and box streaming — none of them are relevant to a crowdfunding escrow.

## Open questions / verify on LocalNet

- Leaf identity on re-pledge (one leaf per pledge vs. accumulate) — lock before
  coding, see above.
- Exact first-pledge minimum with no boxes (should be ~0.1 ALGO).
- The `sha512_256` + `bytes[]` proof loop compiles within the opcode budget.
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
