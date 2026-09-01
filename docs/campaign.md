# Campaign contract

The `Campaign` contract (`smart_contracts/campaign/contract.algo.ts`) is the core of
AlgorArt: a non-custodial crowdfunding escrow. One stateful application per campaign.

Source of truth is the Algorand chain. The contract — not a server — holds pledged ALGO
and enforces the campaign rules.

## State

### Global state

| Key | Type | Meaning |
| --- | --- | --- |
| `creator` | `Account` | Campaign creator; the only account allowed to `claim()` |
| `title` | `bytes` | Short campaign title, fixed at `create()` |
| `metadataUri` | `bytes` | URI of off-chain campaign metadata (ARC-3-style JSON blob) |
| `goal` | `uint64` | Funding target, in microAlgos |
| `deadline` | `uint64` | UNIX timestamp (seconds) after which the outcome is decided |
| `raised` | `uint64` | Total microAlgos pledged so far |
| `status` | `uint64` | `0` Open, `1` Failed, `2` Claimed |

### Boxes

| Map | Key | Value | Meaning |
| --- | --- | --- | --- |
| `pledges` | backer address | `uint64` | That backer's pledged microAlgos |

## State machine

```mermaid
stateDiagram-v2
    [*] --> Open: create(goal, deadline)
    Open --> Open: pledge()
    Open --> Claimed: claim() — deadline passed & raised >= goal
    Open --> Failed: refund() — deadline passed & raised < goal
    Failed --> Failed: refund() — remaining backers reclaim
    Claimed --> [*]
```

## Methods & guards

### `create(title, metadataUri, goal, deadline)`

- `@abimethod({ onCreate: 'require' })` — only runs in the app-create transaction.
- Guards: must be app-create (`applicationId == 0`), `title` non-empty, `title` and
  `metadataUri` at most 128 bytes each (the AVM cap for a bytes global-state value),
  `goal > 0`, deadline in the future.
- Sets `creator`, `title`, `metadataUri`, `goal`, `deadline`, `raised = 0`, `status = Open`.
- `title` is immutable; `metadataUri` is an off-chain pointer (description/image/category).

### `pledge(payment)`

- Takes a `gtxn.PaymentTxn` — the caller submits this app call in a group with a payment
  from their own account to the app's escrow address.
- Guards:
  - before the deadline (`Global.latestTimestamp < deadline`)
  - `payment.receiver == Global.currentApplicationAddress` (escrow)
  - `payment.sender == Txn.sender` (payer is the caller)
  - `payment.amount > 0`
  - `Txn.sender != creator` (a creator cannot pledge to their own campaign)
- Adds `payment.amount` to the backer's box and to `raised`.
- **Re-pledging is allowed** — each payment is added to the existing box total.

### `claim()`

- Creator only (`Txn.sender == creator`), after the deadline, and `raised >= goal`.
- Guards: `status == Open` (prevents double payout).
- Sets `status = Claimed`, then pays the entire escrow balance to the creator.

### `refund()`

- Any backer, after the deadline, and `raised < goal`.
- Materialises `status = Failed` on the first refund; subsequent calls require it.
- Guard: the caller's pledge box must exist (prevents refunding twice or refunding non-backers).
- Deletes the box and pays the box amount back to the caller.

### `cancelPledge()`

> **Proposed** — documented for design alignment; not yet implemented.

- Backer only (`Txn.sender` must have a pledge box), **before** the deadline, while
  the campaign is still `Open`.
- Deletes the caller's pledge box, pays the box amount back to the caller, and
  decrements `raised` by that amount.
- The box delete makes a second cancel impossible (same pattern as `refund`); the
  backer pays ≈ 0.002 ALGO (app call + one inner payment).
- **Trade-off:** while `Open`, `raised` becomes a live, revocable number. A large
  backer can pledge to make a campaign look near-funded, then withdraw just before
  the deadline. This mirrors the creator self-pledge concern (design decision 7)
  but from the backer side, and the deadline remains the sole arbiter of the
  outcome — accepted for a non-custodial demo.

### `refundBatch(backers...)`

> **Proposed** — documented for design alignment; not yet implemented.

- Refunds up to 8 backers in a single call (the AVM box-reference limit), one
  inner payment per backer, deleting each pledge box.
- **Callable by anyone** after the deadline when `raised < goal` — the sweep is
  permissionless, so closure does not depend on the creator returning.
- The outer app-call fee must cover the app call plus one minimum fee per inner
  payment: ≈ 0.009 ALGO for a full batch of 8. Refund amounts are never reduced
  by fees; the caller pays.

## Design decisions

1. **`Funded` is a derived state.** There is no separate `settle()` call, so
   `claim()`/`refund()` evaluate the deadline and goal directly. `Funded` is never
   materialised into global state; only `Open`, `Failed`, and `Claimed` are stored.
2. **Escrow payout is `balance − minBalance`.** The app account must keep its minimum
   balance to remain alive, so the contract only ever pays out the spendable amount.
3. **First pledge uses `Box.get({ default: 0 })`.** Reading a missing box's `.value` would
   fail the transaction, so the first pledge defaults to 0.
4. **Re-pledging accumulates.** A backer's box holds the running total of all their
   payments; no separate pledge counter.
5. **Refund deletes the box after reading it.** This makes a second refund impossible
   (box no longer exists) and is safe because the payment is issued in the same transaction.
6. **`claim()` guards against re-entrancy/replay** with the `already claimed` status check.
7. **Creators cannot self-pledge.** `pledge()` rejects `Txn.sender == creator`. A self-pledge is not a direct
   funds leak (the creator would only move their own ALGO in and out), but it lets a creator fabricate the
   `raised` number to make a campaign look funded — undermining the trust story the contract exists to provide.
8. **Refund sweep is permissionless (proposed).** `refundBatch` is callable by any account, not just the
   creator, so a failed campaign can be fully drained even if the creator never returns. Whoever calls pays the
   batch fee; refund amounts are never reduced.
9. **Pledges are cancellable before the deadline (proposed).** `cancelPledge` lets a backer withdraw while the
   campaign is still `Open`, mirroring Kickstarter's "not charged until the deadline" model. It reintroduces the
   revocable-`raised` concern the self-pledge ban guards against, but the deadline remains the sole arbiter of the
   outcome — accepted for a non-custodial demo.

## Known edge cases

The cases below drive implementation decisions for the proposed methods; they are
referenced from the contract items in [`roadmap.md`](../roadmap.md).

1. **Zero-pledge campaign stays `Open`.** `refund()` materialises `Failed` **and**
   requires the caller's box to exist in the same atomic call, so a campaign nobody
   pledged to can never record `Failed` on-chain. The UI still derives "failed", so it
   is cosmetic — but a permissionless `settle()` (proposed) would close the gap.
2. **Stray ALGO sent directly to the escrow.** A plain payment to the app address
   bypasses `pledge()`. On success `claim()` pays `balance − minBalance`, so stray ALGO
   goes to the creator for free; on failure it is in no box and is stranded after all
   refunds. Documented and accepted.
3. **`refundBatch` poisoning.** A single bad or duplicate address in a batch fails that
   backer's inner payment and reverts the whole batch. The frontend must dedupe and pass
   only live box addresses from the indexer.
4. **Opcode budget.** 8 inner payments + 8 box references approach the app-call budget;
   verify the batch actually compiles and reduce to 6–7 backers if not.
5. **Re-pledge → cancel → re-pledge.** Cancelling deletes the box and decrements
   `raised`; a later pledge must recreate the box with the fresh amount and re-increment
   `raised` correctly (needs an explicit test once `cancelPledge` exists).
6. **Deadline boundary.** Pledging/cancelling use `latestTimestamp < deadline` while
   claim/refund use `>=`, so at the exact `==` block pledging is closed and settlement is
   open. Test the `==` boundary explicitly.
7. **Claim leaves pledge boxes behind.** `claim()` does not delete backer boxes; they are
   harmless dead data, but the UI must not show "your pledge" on a `claimed` campaign.
8. **Overflow is impossible in practice.** `raised` and box values are `uint64`; an
   overflow would need more ALGO than the total supply. No guard needed.

## Frontend integration

The generated client (`CampaignClient.ts`) exposes each method with typed args. The
`pledge` call must be built as a transaction group: a payment from the backer to
`Global.currentApplicationAddress`, passed as the ABI `pay` argument alongside the app call.

> The complete UI design (pages, data flow, call patterns) lives in
> [`docs/frontend.md`](../frontend.md). This section is the *API* view: how each
> method maps to a generated-client call, how the indexer surfaces state, and the
> gotchas discovered while tracing the client's actual behavior.

### Reading state — indexer model

The frontend is a read model over the indexer. Each campaign is an `Application`
whose `params.global-state` is a list of `{ key, value }` pairs:

| Contract key | Global-state `value.type` | Decode as |
| --- | --- | --- |
| `creator` | `1` (bytes) | 32-byte address |
| `title` | `1` (bytes) | UTF-8 string |
| `metadataUri` | `1` (bytes) | UTF-8 string |
| `goal` | `2` (uint) | microAlgos |
| `deadline` | `2` (uint) | UNIX seconds |
| `raised` | `2` (uint) | microAlgos |
| `status` | `2` (uint) | `0` Open, `1` Failed, `2` Claimed |

The indexer keys are **base64 of the UTF-8 key name** (`Z29hbA==` → `goal`, etc.);
decode the key, don't match on base64 directly. `Funded` is not stored — the UI
recomputes it from `deadline`/`raised`/`goal` (same rule the contract evaluates).

Backer pledges are **boxes**, not global state: fetch them with
`indexer.searchForApplicationBoxes(appId)`. A box name is the `p` prefix +
address bytes; a missing box means the backer has not pledged (or already refunded).

### Generated client — call surface

`CampaignClient` (and `CampaignFactory` for deploy) are generated from
`Campaign.arc56.json`. Key facts about the surface:

- **Deploy** uses `CampaignFactory.send.create.create({ args: { goal, deadline } })`
  and returns `{ appClient, result }`; `result.appId` / `result.appAddress`
  identify the new campaign.
- **Methods** are reached three ways: `client.send.<m>()` (sign + submit),
  `client.createTransaction.<m>()` (build a txn to compose), and
  `client.newGroup().<m>()` (an atomic composer). The dApp uses `client.send.*`.
- **Signer/sender are per-call.** Construct the client with
  `{ algorand, appId, defaultSender: activeAddress, defaultSigner: transactionSigner }`
  so the wallet signs; reads (`client.state.*`) need neither.
- **Typed args** (`CampaignArgs['obj']`) accept object form, e.g.
  `{ goal, deadline }` for `create`, `{ payment }` for `pledge`.

### Method → call cheat sheet

```ts
// create — deploy a new campaign (app-create txn)
factory.send.create.create({
  args: {
    title: new TextEncoder().encode(title),
    metadataUri: new TextEncoder().encode(metadataUri),
    goal: goalMicroAlgos,
    deadline: deadlineUnixSeconds,
  },
})

// pledge — the ABI `pay` arg must be a payment txn in the SAME group
client.send.pledge({
  args: {
    payment: await algorand.createTransaction.payment({
      sender: activeAddress,
      receiver: client.appAddress,           // == Global.currentApplicationAddress
      amount: microAlgos(pledgeAmount),
    }),
  },
})

// claim / refund — no args
client.send.claim()
client.send.refund()
```

### Gotchas (learned tracing the client)

- **`pledge` is a two-txn atomic group.** The client adds the payment to the
  composer and passes it as the ABI `pay` argument; the contract then re-checks
  `sender === caller`, `receiver === escrow`, `amount > 0`. Never send the
  payment separately — a standalone payment would bypass the box bookkeeping.
- **Inner payments need fee cover.** `claim`/`refund` issue an inner payment, so
  the outer app-call fee must cover it. Pass
  `coverAppCallInnerTransactionFees: true` in the send params (or add an
  explicit `extraFee`).
- **Box references are auto-populated** (`populateAppCallResources` defaults to
  true), so `pledge`/`refund` don't need manual box arrays.
- **`defaultSender` + `defaultSigner` are required for writes.** Without them the
  client has no sender/signer and the wallet never sees the transaction.
- **Units.** On-chain values are microAlgos (`bigint`); `AlgoAmount`
  (`algo(n)`, `microAlgos(n)`) converts. `deadline` is seconds, not ms.
- **`client.appAddress`** is the escrow address — the receiver for pledges.

## Testing

A full behavioral matrix lives in `contract.algo.spec.ts` — every method × every
branch (caller checks, deadline checks, goal checks, re-pledge, double-claim,
double-refund). Tests run offline via `algorand-typescript-testing` + Vitest.

A LocalNet integration suite in `contract.integration.test.ts` deploys the compiled
TEAL and exercises the full lifecycle (create → pledge → claim, and → refund).

See [`testing.md`](testing.md) for the tooling setup, API cheat sheet, coverage
matrix, and integration notes.
