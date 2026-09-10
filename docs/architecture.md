# Architecture

How AlgorArt is put together: the **escrow** (Campaign + Claim ASA), the
**Factory** (canonical registration), and the optional **catalog** for
discovery and archival.

> Contract internals: [`campaign.md`](campaign.md) and
> [`claim-asa-redesign.md`](claim-asa-redesign.md). Frontend design:
> [`frontend.md`](frontend.md). Product design & open questions:
> [`design.md`](design.md). Roadmap: [`roadmap.md`](roadmap.md).

## The pieces

| | Escrow (per campaign) | Factory (one, platform-owned) | Catalog (optional backend) |
| --- | --- | --- | --- |
| What it is | Campaign app + app account + Claim ASA | On-chain registry app | API + DB |
| Funds it holds | Pledged ALGO + the creator's deposit | Registration deposits | none |
| Lifecycle | Created per campaign; deleted after settlement | Permanent | Permanent |
| Job | Enforce crowdfunding rules | Prove a campaign is official AlgorArt | Browse/search/archive |

### The escrow: one app + one Claim ASA per campaign

Each campaign is an isolated application with its own account and its own Claim
ASA. Backers hold claim units on their own wallets; the campaign's own storage
never grows with the backer count. Full internals:
[`campaign.md`](campaign.md).

### The Factory: canonical registration, not shared custody

The Factory is an **on-chain registry** (`smart_contracts/factory/contract.algo.ts`),
not an escrow: it holds no campaign funds, takes no part in pledging, refunding,
or cleanup, and is never a per-backer bottleneck. It does three things:

1. **Authenticity.** The platform owner configures the SHA-256 of the official
   Campaign approval program. `register(app, payment)` verifies a newly created
   campaign app against that hash and its creator, then records
   `app id → creator` in a box. Copies of the contract cannot register.
2. **Refundable registration deposit.** Registration pays ≈ 0.019 ALGO (the
   registration box's MBR) to the Factory account; `unregister(app)` deletes
   the box and pays it back to the creator when the campaign is deleted.
3. **The canonical id source for the frontend.** The browse page lists only
   Factory-registered campaigns (one box search), so official campaigns are
   distinguishable from arbitrary copies without any backend.

The Factory is the on-chain counterpart of the frontend's generated
`CampaignFactory` *client* — the client is tooling; the Factory app is the
registry.

### The catalog: optional, and thinner than before

The Claim ASA removed the last hard reason for a backend:

- **Discovery** — the Factory registration boxes give the official campaign
  list without a catalog.
- **Refund proofs** — gone; refunds are asset transfers, so there is no
  backend proof endpoint.
- **Archival** — a deleted campaign's global state remains queryable on the
  indexer (with `deleted` / `deleted-at-round`), and backers' balances of a
  *destroyed* ASA are not needed by anyone afterwards, so there is no
  box-MBR residue to snapshot around.

What a catalog still buys is **search, filtering, and history UX** (the
indexer has no text search and no "list apps by approval program"). If one is
built, it stays a projection: one row per campaign, written at creation and
finalized by a watcher, rebuildable by re-syncing the indexer. It never holds
keys, funds, or authority.

## Creation flow

1. The creator signs the Campaign `create()` (frontend, generated
   `CampaignFactory` client) — one app-create transaction.
2. The creator calls `fund()` with the 0.2 ALGO storage deposit — the same
   call issues the Claim ASA.
3. The creator calls the Factory's `register(app, payment)` with the
   ≈ 0.019 ALGO deposit. From then on the campaign appears in the official
   browse list.

The frontend chains 1–3 into a single user action
([`frontend.md`](frontend.md)).

## Settlement flows (no backend involved)

- **Success:** creator calls `claim()`; backers `closeOut()` their claim units
  when convenient; the creator `delete()`s (ASA destroyed, escrow swept,
  Factory deposit returned) once all units are home.
- **Failure:** each backer calls `refund()` themselves; the creator `delete()`s
  once the escrow is empty.
- **Abandoned (never funded):** the creator can `delete()` immediately.

None of these paths iterate backers on the platform's behalf.

## References

Official Algorand docs backing the claims in this file (verify against these
when in doubt):

- [Applications](https://dev.algorand.co/concepts/smart-contracts/apps/) — app
  lifecycle and deletion.
- [Asset Operations](https://developer.algorand.org/docs/get-details/asa/) —
  ASA deletion and opt-in/out semantics.
- [Indexer REST API](https://dev.algorand.co/reference/rest-api/indexer/) —
  application `deleted` / `deleted-at-round` fields, `include-all`, box and
  asset-balance lookups.
