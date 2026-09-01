# Roadmap

A living checklist of what's left to do. Work already done is collapsed into a
short summary at the top; the rest is organized by **area**, not by phase. Each
item links to the doc that has the details.

> Contract internals: [`contracts/campaign.md`](contracts/campaign.md). Frontend
> design: [`frontend.md`](frontend.md). Product design & open questions:
> [`design.md`](design.md). CI: [`ci.md`](ci.md). Testing:
> [`contracts/testing.md`](contracts/testing.md).

## Done

- [x] **Setup** — AlgoKit workspace, toolchain, LocalNet sandbox, lint/format/type-check, CI.
- [x] **Contract** — `create`/`pledge`/`claim`/`refund` with full behavioral + integration tests.
- [x] **Frontend core** — wallet connect (Pera/Defly), browse, create, pledge, claim/refund.

## Contract

- [ ] **Decide `updateMetadata()` before any "final" deploy** — without it, `title`
      and `metadataUri` are immutable forever (see [`campaign.md`](contracts/campaign.md)).
- [ ] **`cancelPledge()`** — backer withdraws while the campaign is `Open` (needs a contract change).
- [ ] **`refundBatch()`** — refund up to 8 backers in one permissionless call; loop until drained.
- [ ] **Decide on `settle()`** — closes the zero-pledge-campaign gap (cosmetic; the UI already derives "failed").
- [ ] **Verify `refundBatch` fits the opcode budget** — drop to 6–7 backers if it doesn't compile.
- [ ] **Tests** for cancel/batch/re-pledge flows once the methods exist (see [`testing.md`](contracts/testing.md)).

## Frontend UX

- [ ] Backer banner on failed campaigns ("You're owed X ALGO — Refund my pledge").
- [ ] Fee disclaimers beside every money-moving button.
- [ ] "Refund all" batch-sweep UI.
- [ ] "Cancel pledge" action on open campaigns.
- [ ] Handle the known UI edge cases (indexer lag, clock drift, wallet/network mismatch) — see [`frontend.md`](frontend.md).

## Content & metadata

- [ ] Rich off-chain rendering (IPFS image/description/category) — `title` + `metadataUri` are implemented; rendering the JSON blob is not.
- [ ] Real styled UI: design tokens, layout, cards, detail page, create flow, states, accessibility — see [`design.md`](design.md).

## TestNet & deployment

- [ ] **TestNet smoke test** — deploy the current contract, fund via the dispenser, and run
      create → pledge → claim, and → refund with a real wallet (Pera/Defly). This de-risks
      wallet + public-network integration and is independent of styling.
- [ ] **Lock the contract shape** (decide `updateMetadata()` / `settle()`) before the first demo deploy.
- [ ] Deploy the frontend to a **free static host** (GitHub Pages / Cloudflare Pages / Netlify).

## CI & packaging

- [ ] Wire up the CI coverage gate + lint/format/type-check gate (workflow partially done — see [`ci.md`](ci.md)).
- [ ] Package the frontend as a container image for portable hosting.
- [ ] Publish the ARC-32/56 spec.

## Product & design (later)

These are plans, not code — see [`design.md`](design.md):

- [ ] Profiles & notifications (minimal backend, chain watcher, email).
- [ ] Content & UI polish, IPFS pinning, PWA + web push, trust & safety.
- [ ] Resolve the open product questions (email provider, fees, backend hosting, KYC).
