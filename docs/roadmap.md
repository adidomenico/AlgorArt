# Roadmap

A living checklist of what's left to do. Work already done is collapsed into a
short summary at the top; the rest is organized by **area**, not by phase. Each
item links to the doc that has the details.

> Contract internals: [`campaign.md`](campaign.md) and
> [`claim-asa-redesign.md`](claim-asa-redesign.md). Frontend design:
> [`frontend.md`](frontend.md). Product design & open questions:
> [`design.md`](design.md). CI: [`ci.md`](ci.md). Testing:
> [`testing.md`](testing.md). Factory & catalog:
> [`architecture.md`](architecture.md).

## Done

- [x] **Setup** — AlgoKit workspace, toolchain, LocalNet sandbox, lint/format/type-check, CI.
- [x] **Contract** — `create`/`fund`/`pledge`/`claim`/`refund`/`cancelPledge`/`closeOut`/`delete`
      with full behavioral + integration tests.
- [x] **Claim ASA redesign** — replaced the Merkle tree + spent bitmap with a per-campaign
      Claim ASA whose balances are the anti-double-refund state; no boxes, no proofs, no
      per-backer campaign storage. See [`claim-asa-redesign.md`](claim-asa-redesign.md).
      (Superseded by the [Claim-tree rewrite](#claim-tree-rewrite-current-track) below; kept as history.)
- [x] **Factory registry** — on-chain Factory app: owner-configured approval hash,
      `register`/`unregister` with a refundable deposit, program-hash verification against
      impostor copies. See [`architecture.md`](architecture.md).
- [x] **Split vault** — the ClaimsVault holds the backers' pooled pledges and issues each
      campaign's Claim ASA; the campaign escrow holds only the creator's deposit, so both
      settlement paths finalize in O(1) and failed-campaign refunds keep working from the
      vault after the campaign is deleted. Full attack matrix on LocalNet.
      (ASA issuance is removed by the rewrite; the pooled escrow stays.)
- [x] **Frontend core** — wallet connect (Pera/Defly), browse (Factory-filtered), create
      (+ fund + register), pledge (auto opt-in), claim/refund/cancel, close-out, delete.
- [x] **LocalNet deploy + seed** — Factory/ClaimsVault/Campaign deployers and a demo seed
      script (create → fund → register → issue → attach → seed → pledge).

## Claim-tree rewrite (current track)

Decision: replace the Claim ASA with the Incremental Frontier-Merkle claim tree. The spec is
[`claim-tree-protocol.md`](claim-tree-protocol.md) (Amendment A1 applied); a LocalNet spike already
proved pledge → refund differentially against the Python oracle. Commits are ordered so every step
stays green (format, lint, types, offline coverage at 100%, integration on LocalNet).

### Phase 0 — decisions (block C1, no code)

- [ ] **`sweepTarget` + window** — who receives the post-window residual, and confirm 730 days
      (see [`claim-tree-protocol.md`](claim-tree-protocol.md) → Refund window decision). The vault's
      `finalize` needs the address source.
- [ ] **Spike retirement** — migrate the differential asserts into the campaign suite, delete
      `smart_contracts/claimtree/`, remove the coverage exclusion.
- [ ] **Confirm the drops** — `fund()`, `attachClaimAsa`, `closeOut`, `claimAsa`/`deposit` state,
      and the vault ASA methods (`issueClaimAsa`, `seedSupply`, `sweepClaimAsa`, `destroyClaimAsa`).
- [ ] **Proof strategy** — client-only indexer replay for v1 (a backend proof endpoint stays a later
      item under Backend & archival).

### C1 — contracts: replace claim ASA with claim-tree escrow

- [ ] **Vault rewrite** (in place) — add `credit` (top-level), `payBack`, `payClaim`, `settle`,
      `settleOpen`, `refund` (vault path), `notifyDelete`, `finalize` on the 65-byte box; delete all
      ASA methods.
- [ ] **Campaign rewrite** (in place) — add `root`/`N` state, `pledge(payment, frontier)`,
      `cancelPledge`, `refund`, `claim`, `delete` with `ensureBudget` sizing; port the spike patterns
      (`isOdd`, early-exit `popcount`/`pathLen`, `op.sha512_256`).
- [ ] **Factory needs no code change** — `setApprovalHash` already covers v2; tests register the new hash.
- [ ] **Tests** — offline specs rewritten (100% gate holds), integration suite rewritten with oracle-CLI
      differential asserts, spike dir deleted. Rewrite [`campaign.md`](campaign.md) in the same set.

### C2 — frontend: claim-tree proof builder

- [ ] New `lib/claimtree.ts` — replay pledge/null events from the indexer into frontiers (pledges) and
      paths (refunds); read-only TS port of the reference model.
- [ ] Unit tests against committed oracle vectors (generate once from Python, commit the JSON — no Python
      dependency in frontend CI). No UI changes yet.

### C3 — frontend: claim-tree flows

- [ ] `transaction.ts` — `[pay, pledge, credit]` groups, cancel/refund/claim/delete with box/app refs and
      OpUp `extraFee`; delete all ASA flows (issue/attach/seed/sweep/destroy/opt-in).
- [ ] UI — proof-building states (loading frontier/path, stale-proof retry), fee disclaimers, 730-day
      refund-window banner; covers the unchecked Frontend UX items above. Update
      [`frontend.md`](frontend.md) in the same set.

### C4 — docs: retire claim ASA

- [ ] README spec section, [`testing.md`](testing.md) rows, this roadmap; superseded header on
      [`claim-asa-redesign.md`](claim-asa-redesign.md) (kept as history).

### C5 — TestNet smoke (no code)

- [ ] Full lifecycle with a real wallet on the v2 contracts; record results under TestNet & deployment.

## Contract

- [ ] **Decide `updateMetadata()` before any "final" deploy** — without it, `title`
      and `metadataUri` are immutable forever (see [`campaign.md`](campaign.md)).

## Frontend UX

- [ ] Backer banner on failed campaigns ("You're owed X ALGO — Refund my pledge").
- [ ] Fee disclaimers beside every money-moving button.
- [x] "Cancel pledge" action on open campaigns.
- [x] "Close out my claim" action on claimed campaigns.
- [x] "Delete campaign" action for creators on settled campaigns.
- [ ] Handle the known UI edge cases (indexer lag, clock drift, wallet/network mismatch) — see [`frontend.md`](frontend.md).

## Content & metadata

- [ ] Rich off-chain rendering (IPFS image/description/category) — `title` + `metadataUri` are implemented; rendering the JSON blob is not.
- [ ] Real styled UI: design tokens, layout, cards, detail page, create flow, states, accessibility — see [`design.md`](design.md).

## TestNet & deployment

- [ ] **TestNet smoke test** — deploy the Factory + Campaign contracts, fund via the dispenser, and run
      create → pledge → claim, and → refund with a real wallet (Pera/Defly). This de-risks
      wallet + public-network integration and is independent of styling.
- [ ] **Lock the contract shape** (decide `updateMetadata()`) before the v2 demo deploy.
- [ ] Deploy the frontend to a **free static host** (GitHub Pages / Cloudflare Pages / Netlify).

## Backend & archival

The catalog is an optional minimal backend (API + DB) — see
[`architecture.md`](architecture.md). The Factory + indexer already cover
discovery and the outcome record; the catalog is for search/filter/history UX.

- [ ] **Minimal catalog backend** — API + DB storing one row per campaign (app id, creator, title, metadata URI, goal, deadline, status, outcome, raised, backer count), serving browse/detail pages for ended campaigns.
- [ ] **Chain watcher** — observes the indexer and finalizes campaign records (created/pledged/claimed/refunded/deleted) into the catalog.

## Testing

- [ ] **Browser E2E / acceptance tests** — drive the real UI against LocalNet
      (click Pledge → confirm → Cancel pledge, browse, create, claim, refund) with a
      test signer standing in for the wallet. See [`testing.md`](testing.md) →
      "Browser E2E / acceptance tests".

## CI & packaging

- [ ] Wire up the CI coverage gate + lint/format/type-check gate (workflow partially done — see [`ci.md`](ci.md)).
- [ ] Package the frontend as a container image for portable hosting.
- [ ] Publish the ARC-32/56 specs.

## Open design questions

- [ ] **Residual + cleanup cadence.** Successful campaigns delete O(1) with nothing parked;
      failed campaigns hold the pool until `finalize` sweeps the residual to `sweepTarget` after the
      window. Decide `sweepTarget` (Phase 0 above), and whether the platform or the community drives
      `finalize` (see [`claim-tree-protocol.md`](claim-tree-protocol.md) → Refund window decision).
- [ ] **Pooled-custody review.** The vault concentrates all campaign funds; consider a
      third-party audit of the vault before TestNet.

## Product & design (later)

These are plans, not code — see [`design.md`](design.md):

- [ ] Profiles & notifications (minimal backend, chain watcher, email).
- [ ] Content & UI polish, IPFS pinning, PWA + web push.
- [ ] Backers list, creator page, category filters, analytics, trust & safety.
- [ ] Resolve the open product questions (email provider, fees, backend hosting, KYC).
