# Architecture

How AlgorArt is put together: the **escrow** (Campaign + Claim ASA), the **ClaimsVault** (the pooled refund escrow and asset issuer), the
**Factory** (canonical registration), and the optional **catalog** for discovery and archival.

> Contract internals: [`campaign.md`](campaign.md) and
> [`claim-asa-redesign.md`](claim-asa-redesign.md). Frontend design:
> [`frontend.md`](frontend.md). Product design & open questions:
> [`design.md`](design.md). Roadmap: [`roadmap.md`](roadmap.md).

## The pieces

| | Campaign escrow (per campaign) | ClaimsVault (one, platform-owned) | Factory (one, platform-owned) | Catalog (optional backend) |
| --- | --- | --- | --- | --- |
| What it is | Campaign app + app account + seeded Claim supply | Permanent pooled refund escrow + ASA issuer | On-chain registry app | API + DB |
| Funds it holds | The creator's 0.2 ALGO deposit | All backers' pledged ALGO, pooled | Registration deposits | none |
| Lifecycle | Created per campaign; deleted after settlement | Permanent | Permanent | Permanent |
| Job | Enforce crowdfunding rules; mint claim units | Pay refunds/cancels/claims; settle; GC | Prove a campaign is official AlgorArt | Browse/search/archive |

### The campaign escrow: creator capital only

Each campaign is an isolated application whose escrow holds **only the creator's storage deposit** (0.2 ALGO: account base + Claim ASA
opt-in). Backers' pledges go to the vault; the campaign's own storage never grows with the backer count, and both settlement paths
finalize in O(1). Full internals: [`campaign.md`](campaign.md).

### The ClaimsVault: pooled custody, constant-bounded finalization

The vault is a permanent platform app that:

1. **Issues each campaign's Claim ASA** (`issueClaimAsa`, creator-gated, official-program-hash verified **and Factory registration
   verified on-chain** via an inner call to `isRegistered`) and **seeds its whole supply** to the campaign app (`seedSupply`), so the
   campaign mints claim units per pledge without any per-pledge vault involvement. An unregistered campaign can never park the vault's
   minimum balance.
2. **Holds all pledged ALGO** in one pooled account. Solvency is by conservation, not bookkeeping: every unit is minted against a payment
   verified into the vault, refunds pay exactly the surrendered units, and the claim payout is **derived** as
   `total − vault holding − campaign holding`.
3. **Pays out** on the campaign's authority (`payBack`, `payClaim`, `settle` — inner-call-gated to the registered campaign's own app
   account) and **serves refunds directly** after a failed settlement (`refund(app, axfer)`) — permanently, including after the campaign
   app is deleted. `payBack` **derives the payout from the ledger** (`raised − (T − U − H)`, the surrendered amount) rather than
   trusting a caller-supplied figure.
4. **Garbage-collects** (`sweepClaimAsa` after a claim, `destroyClaimAsa` when the supply is home) to release its parked ~0.166 ALGO of
   MBR per campaign — optional, permissionless, off any critical path. `destroyClaimAsa` also covers the **orphan** case (issued but
   never attached), so the `issue → abandon` lifecycle can never strand the vault's minimum balance.

The vault is the honest concentration of trust: one audited, non-updatable contract holds all campaign funds. See
[`claim-asa-redesign.md`](claim-asa-redesign.md) for the security analysis and the accepted parked-MBR economics.

### The Factory: canonical registration, not shared custody

The Factory is the on-chain **registry**, unchanged in role: it verifies a new campaign app against the owner-configured official
approval-program hash and records `app id → creator` against a refundable deposit. It holds no campaign funds and takes no part in
pledging, refunding, or cleanup. The ClaimsVault reads the Factory's official hash when issuing assets, so a modified program can never
obtain a Claim ASA.

## Creation flow

1. The creator signs the Campaign `create(vault, …)` — one app-create transaction.
2. The creator calls `fund()` with the 0.2 ALGO storage deposit.
3. The creator registers with the Factory (≈ 0.019 ALGO refundable deposit) — **required**: the vault's `issueClaimAsa` verifies the
   registration on-chain, so `create → issueClaimAsa → abandon` is impossible for unregistered campaigns.
4. The creator calls `vault.issueClaimAsa(app)`, then `attachClaimAsa(asset)` (the vault records the attach), then
   `vault.seedSupply(app)` — one claim asset, fully seeded.

The frontend chains 1–4 into a single user action ([`frontend.md`](frontend.md)).

## Settlement flows (no backend involved)

- **Success:** creator calls `claim()` (the vault pays from unit conservation and records the claimed settlement); backers `closeOut()`
  when convenient; the creator `delete()`s in O(1) — the holding closes to the vault, the escrow to the creator.
- **Failure:** each backer calls `refund()` themselves — through the campaign while it lives; the creator `delete()`s in O(1) (recording
  the failed settlement), after which backers refund **directly from the vault forever**. A straggler's ALGO is never swept.
- **Abandoned (never funded):** the creator can `delete()` immediately.

None of these paths iterates backers on the platform's behalf.

## References

Official Algorand docs backing the claims in this file (verify against these when in doubt):

- [Applications](https://dev.algorand.co/concepts/smart-contracts/apps/) — app lifecycle and deletion.
- [Asset Operations](https://developer.algorand.org/docs/get-details/asa/) — ASA deletion and opt-in/out semantics.
- [Indexer REST API](https://dev.algorand.co/reference/rest-api/indexer/) — application `deleted` / `deleted-at-round` fields,
  `include-all`, box and asset-balance lookups.
