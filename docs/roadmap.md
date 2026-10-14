# Roadmap

This page tracks remaining work by area. Completed work is summarized under Done;
each open item links to the doc with the details. Design context is in
[`design.md`](design.md); contract behavior is in [`campaign.md`](campaign.md).

## Done

- [x] **Setup** - AlgoKit workspace, toolchain, LocalNet sandbox, lint/format/type-check, CI.
- [x] **Contract** - `create`/`pledge`/`cancelPledge`/`refund`/`claim`/`delete`
      with full behavioral + integration tests.
- [x] **Claim-tree escrow** - incremental frontier-Merkle tree: no assets, no opt-ins, no per-backer storage anywhere.
      See [`claim-tree-protocol.md`](claim-tree-protocol.md).
- [x] **Factory registry** - on-chain Factory app: owner-configured approval hash,
      `register`/`unregister` with a refundable deposit, program-hash verification against
      impostor copies. See [`architecture.md`](architecture.md).
- [x] **Split vault** - the ClaimsVault holds the backers' pooled pledges; the campaign escrow
      is never funded, so both settlement paths finalize in O(1) and failed-campaign refunds keep
      working from the vault after the campaign is deleted. Full attack matrix on LocalNet.
- [x] **Frontend core** - wallet connect (Pera/Defly), browse (Factory-filtered), create
      (+ register), pledge, claim/refund/cancel, delete.
- [x] **LocalNet deploy + seed** - Factory/ClaimsVault/Campaign deployers and a demo seed
      script (create → register → pledge).

## Frontend UX

- [ ] Backer banner on failed campaigns ("You're owed X ALGO - Refund my pledge").
- [x] **Gate creating behind connection** - disconnected visitors see a "connect wallet to
       create a campaign" prompt and a disabled New campaign button instead of a dead form.
- [x] **Single-click create** - the Create button pins the cover, pins the metadata blob,
       and creates the campaign in one flow sharing a single session (one SIWA popup per
       7 days, pre-warmed at connect); campaigns without a cover skip pinning entirely.
- [x] **Upload filenames** - cover pins keep the original file name (sanitized); metadata
       blobs are named after the campaign title. (CIDs are content-addressed either way, so
       names are display-only in Pinata.)
- [ ] **Creator display names via NFDs** - resolve NFDomains (`name.algo`) for creator/backer
       display on cards and detail, with truncated-address fallback for unnamed accounts
       (names are opt-in and cost ALGO; resolution is a free off-chain read).
- [x] Fee disclaimers beside every money-moving button (see [`frontend.md`](frontend.md) fee table).
- [x] "Cancel pledge" action on open campaigns.
- [x] "Delete campaign" action for creators on settled campaigns.
- [x] **Spend-action signers** - refund/cancel/claim register the wallet signer before sending (the generated client drops `defaultSigner` when `sender` is passed explicitly, so these threw "No signer found" on a fresh page session); that error now classifies as a dead session and spend buttons require a live signer.
- [ ] Handle the known UI edge cases (indexer lag, clock drift, wallet/network mismatch) - see [`frontend.md`](frontend.md).
- [ ] **Defly first-connect fails** - the first connect attempt fails; the second succeeds. Reproduce, then fix or retry-in-place so one click is enough.
- [ ] **Wallet × platform audit** - Defly fires a `defly-wc://` deep link with no registered handler on desktop browsers. Record the expected flow per wallet (Defly/Pera/Exodus) per platform (Brave/Chrome/Firefox desktop, iOS/Android): QR, extension, or app-switch; add availability hints and fallback messaging where a flow can't work. Defly also lacks `signData`, so cover uploads fail closed for Defly users - say so in the UI instead of a raw error. Feeds the TestNet smoke test below.
- [ ] **Dead sessions look connected (confirmed)** - wallet-side disconnect refreshes the nav, but a silently dead bridge keeps the address + Account button (`isConnected`/`activeAddress` are store-derived, never bridge-derived). Fixed by the items below.
- [x] **Liveness revalidation** - new `lib/session.ts` `ensureLiveSessionFor()` rechecks the bridge through the adapter's silent `resumeSession()` on tab-visible and before every money-moving action; a dead bridge throws `Wallet session expired` into the existing dead-session handling.
- [x] **Nav reflects liveness** - needed no extra state: a failed revalidation clears the store via the adapter's `onDisconnect()`, and the nav already reads the store, so it flips to Connect wallet on its own.
- [x] **Backend JWT hygiene** - the cached token is keyed by address (switching wallets signs in fresh instead of reusing the previous account's token) and `clearSession()` runs on logout.
- [ ] **Gate uploads on `canSignData`** - Defly lacks `signData`, so cover uploads fail at sign time; say so up front instead of a raw error.
- [ ] **App chrome: navbar + footer** - navbar: logo left (home), search box center,
      hamburger menu right; footer: brand + `© <year> AlgorArt`, Contacts, Privacy
      Policy, non-custodial disclaimer. New `features/app/` components, Tailwind.
- [ ] **Search** - navbar search filters the browse list by title client-side
      (state in `CampaignList`); indexer/catalog-backed search stays a Backend item.
- [ ] **Hamburger menu** - Profile, My pledges, My projects, Settings. The wallet
      button stays persistent top-right *outside* the menu: connection state must
      always be visible (see edge cases in [`frontend.md`](frontend.md)), and
      connect/disconnect is too frequent to bury behind two taps.
- [ ] **Profile section** - address + network, my pledges (live leaves via
      `fetchMyLeaves`), my projects (campaigns filtered by creator).
- [x] **Settings section** - profile form (display name/bio/avatar/email) and settings
      form (notification prefs, theme) behind the account menu, wired to the backend CRUD.

## Content & metadata

- [x] Rich off-chain rendering (IPFS image/description/category) - ARC-3-style blob rendered in card/detail via the public gateway; cover and metadata pinning flow through the backend, single-click create still open (see [`frontend.md`](frontend.md) → Campaign metadata).
- [ ] Real styled UI: design tokens, layout, cards, detail page, create flow, states, accessibility - see [`design.md`](design.md).

## TestNet & deployment

- [x] **TestNet deploy** - Factory `773811780` + ClaimsVault `773811800`
      (approval hash set at deploy; sweep target = deployer, 730-day window).
      View on Lora: `https://lora.algokit.io/testnet/application/<id>/`.
- [ ] **TestNet smoke test** - run create → pledge → claim and create → pledge → refund
      against the deployed apps with a real wallet (Pera/Defly). This de-risks
      wallet + public-network integration and is independent of styling.
- [x] **Lock the contract shape** - decided: no `updateMetadata()`; title and metadata URI stay immutable
      (a backer's pledge can never be re-described under them; mutability can come later via the off-chain JSON).
- [ ] Deploy the frontend to a **free static host** (GitHub Pages / Cloudflare Pages / Netlify).

## Backend & archival

The catalog is an optional minimal backend (API + DB) - see
[`architecture.md`](architecture.md). The Factory + indexer already cover
discovery and the outcome record; the catalog is for search/filter/history UX.

Backend service (`projects/backend`, Fastify + Postgres) lands in thin slices,
one commit each - CI wiring comes last:

- [x] **Scaffold** - project skeleton with a `/health` endpoint; lint/format/type-check gates green.
- [x] **Postgres + migrations** - docker compose service, migration runner, `profiles`, `settings`, and `auth_nonces` tables.
- [x] **Wallet-signature auth** - sign-in challenge (`POST /auth/challenge`, 5-minute TTL) + JWT verify (`POST /auth/verify`, HS256, 7-day tokens) + authenticated `GET /me`; no passwords, per
      [`design.md`](design.md); tests included.
- [x] **`POST /uploads`** - authenticated server-side Pinata pinning, returns the CID.
- [x] **Create-form upload** - cover picker pins through `POST /uploads` (wallet `signData` sign-in) into a readonly metadata-URI display, upload button first. Gated on the wallet's signing capability.
- [x] **Cover upload button + readonly URI** - the metadata URI renders as readonly debug text, not an editable field.
- [x] **Metadata upload** - description box plus category dropdown; an Upload metadata button pins `{name, description, image, category}` through `POST /uploads/metadata` (Name = campaign title, required) into the same display.
- [ ] **use-wallet v5 + ARC-60 sign-in** - unlocks Pera cover uploads (v5 adds Pera `signData`, but signs ARC-60 structures, so verification moves off `MX||message`). Lands in two commits, in order:
  1. [x] Frontend v5 upgrade (adapter packages, factory config, storage key, type renames). Uploads fail closed until step 2 lands.
  2. [x] ARC-60 verification end-to-end (backend verifies `sha256(data)||sha256(authenticatorData)` + domain binding; frontend sends the ARC-60 payload). Pera trial on TestNet still open - see below.
- [x] **Pera upload trial** - cover picker → Upload with Pera on TestNet passed; the URI fills in.
- [x] **Profiles + settings CRUD** - `GET /profiles?address=` (public) plus authenticated `PUT /profiles` (display name/avatar/bio/email, partial updates, null clears) and `GET`/`PUT /settings` (notification prefs, theme, defaults served when unsaved); frontend profile section reads them.
- [x] **CI matrix** - backend lane in `build-and-test` (own job with a Postgres service; landed early, ahead of the remaining slices).

- [ ] **Minimal catalog backend** - API + DB storing one row per campaign (app id, creator, title, metadata URI, goal, deadline, status, outcome, raised, backer count), serving browse/detail pages for ended campaigns.
- [ ] **Chain watcher** - observes the indexer and finalizes campaign records (created/pledged/claimed/refunded/deleted) into the catalog.
- [ ] **Creator updates feed** - append-only, timestamped, creator-signed messages stored by the catalog and shown as history on the
      detail page; the original description stays frozen and always viewable. No contract change: signatures are verified off-chain
      against the on-chain creator address. Typos get corrected and progress gets shared, but silent rewrites stay impossible -
      the decentralized equivalent of Kickstarter's Updates tab.

## Testing

- [ ] **Browser E2E / acceptance tests** - drive the real UI against LocalNet
      (click Pledge → confirm → Cancel pledge, browse, create, claim, refund) with a
      test signer standing in for the wallet. See [`testing.md`](testing.md) →
      "Browser E2E / acceptance tests".

## CI & packaging

- [ ] Wire up the CI coverage gate + lint/format/type-check gate (workflow partially done - see [`ci.md`](ci.md)).
- [ ] Package the frontend as a container image for portable hosting.
- [ ] Publish the ARC-32/56 specs.

## Open design questions

- [ ] **Residual + cleanup cadence.** Successful campaigns delete O(1) with nothing parked;
      failed campaigns hold the pool until `finalize` sweeps the residual to the treasury `sweepTarget` after the
      window (decided: see [`claim-tree-protocol.md`](claim-tree-protocol.md) → Refund window decision). Still open: whether the platform or the community drives
      `finalize` (see [`claim-tree-protocol.md`](claim-tree-protocol.md) → Refund window decision).
- [ ] **Pooled-custody review.** The vault concentrates all campaign funds; consider a
      third-party audit of the vault before TestNet.

## Product & design (later)

These are plans, not code. Details are in [`design.md`](design.md):

- [ ] Profiles & notifications (minimal backend, chain watcher, email).
- [ ] Content & UI polish, IPFS pinning, PWA + web push.
- [ ] Backers list, creator page, category filters, analytics, trust & safety.
- [ ] Resolve the open product questions (email provider, fees, backend hosting, KYC).
