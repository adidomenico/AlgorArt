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
- [x] **Factory registry** — on-chain Factory app: owner-configured approval hash,
      `register`/`unregister` with a refundable deposit, program-hash verification against
      impostor copies. See [`architecture.md`](architecture.md).
- [x] **Frontend core** — wallet connect (Pera/Defly), browse (Factory-filtered), create
      (+ fund + register), pledge (auto opt-in), claim/refund/cancel, close-out, delete.
- [x] **LocalNet deploy + seed** — Factory/Campaign deployers and a demo seed script
      (deploy → fund → register → pledge).

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
- [ ] **Lock the contract shape** (decide `updateMetadata()` / `settle()`) before the first demo deploy.
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

- [ ] **Force-close for claimed campaigns.** The Claim ASA cannot be destroyed until
      every backer closes out; a single lazy wallet parks the creator's ~0.67 ALGO.
      Evaluate clawback- or bounty-based force-close (see
      [`claim-asa-redesign.md`](claim-asa-redesign.md) → Limitations).

## Product & design (later)

These are plans, not code — see [`design.md`](design.md):

- [ ] Profiles & notifications (minimal backend, chain watcher, email).
- [ ] Content & UI polish, IPFS pinning, PWA + web push.
- [ ] Backers list, creator page, category filters, analytics, trust & safety.
- [ ] Resolve the open product questions (email provider, fees, backend hosting, KYC).
