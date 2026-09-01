# Roadmap

The single source of truth for where AlgorArt is going. This replaces the inline
README roadmap and the former `docs/production-roadmap.md`: it carries the phased
plan (setup → contract → frontend → TestNet → polish), the later product phases
(identity, backend, notifications, UI), the proposed contract changes, and the
known edge cases, all in one place.

> Contract internals: [`contracts/campaign.md`](contracts/campaign.md). Frontend
> design: [`frontend.md`](frontend.md). CI: [`ci.md`](ci.md). Testing:
> [`contracts/testing.md`](contracts/testing.md).

## Guiding principle

Keep the parts that matter on-chain **on-chain**, and keep the parts that are
personal/private **off-chain**:

- **Money, escrow, and outcome rules** — always on-chain (already true).
- **Campaign identity** (title, description, image) — hybrid: short title on-chain
  (**implemented**), long content off-chain (see `docs/frontend.md`).
- **Email addresses, notification preferences, profiles** — off-chain only. Never
  on-chain, never in the contract.

This keeps the contract auditable and the dApp's privacy surface small.

## Status at a glance

| Phase | Scope | Status |
| --- | --- | --- |
| 0 — Setup | AlgoKit workspace, toolchain, sandbox, lint/format/type-check | ✅ done |
| 1 — Smart contract | `create`/`pledge`/`claim`/`refund` + full behavioral tests | ✅ done |
| 2 — Frontend | Wallet connect, browse, create, pledge, claim/refund UI | ✅ done |
| 3 — TestNet | Deploy + end-to-end demo | ⬜ next |
| 4 — Polish | Refund UX, cancel/batch, metadata rendering, CI | ⬜ planned |
| A/B/C — Product | Content & UI, profiles & notifications, polish | ⬜ design only |

## Phase 0 — Setup (done)

- [x] `algokit init` — AlgoKit workspace (contracts + frontend projects).
- [x] Toolchain: Node.js, Docker Desktop, AlgoKit CLI.
- [x] README spec written.
- [x] Local sandbox (algod + indexer in Docker) up and verified.
- [x] Lint, format, and type-check tooling wired up (ESLint + Prettier + tsc).

## Phase 1 — Smart contract core (done)

- [x] `campaign/contract.algo.ts`: `create`, `pledge`, `claim`, `refund`.
- [x] Campaign metadata: on-chain `title` + `metadataUri` (off-chain pointer) on `create()`.
- [x] Contract tests: **100% behavioral coverage** — every method × every branch
      (pledge before/after deadline, claim gating by caller/deadline/goal/double-claim,
      refund gating by deadline/outcome/backer/double-refund). Offline AVM tests in
      `contract.algo.spec.ts`; matrix in `docs/contracts/testing.md`.
- [x] Localnet deployment exercised end-to-end (create → pledge → claim, and → refund)
      via `contract.integration.test.ts`.

## Phase 2 — Frontend (done)

The full UI plan — pages, data flow, and the exact `create`/`pledge`/`claim`/`refund`
call patterns — is designed in [`docs/frontend.md`](frontend.md).

- [x] Wallet connect (Pera / Defly) via `use-wallet` (from the AlgoKit starter).
- [x] Campaign list & detail — read global state + boxes via indexer.
- [x] Create campaign form → `create()` ABI call.
- [x] Pledge flow → `pledge()` ABI call (payment + app call in one group).
- [x] Claim & refund buttons → `claim()` / `refund()` ABI calls.
- [x] Unit tests (Vitest) with line coverage ≥ 90% on components & utils.

## Phase 3 — TestNet demo (next)

- [ ] Deploy contracts to **TestNet**.
- [ ] Deploy the frontend to a static host (any CDN / static file server).
- [ ] Fund a wallet via the TestNet dispenser.
- [ ] End-to-end demo: create → pledge → claim (success case) and → refund (failure case).

## Phase 4 — Polish

### Refund UX & fee disclaimers

- [ ] Backer banner on failed campaigns: "You're owed X ALGO — Refund my pledge
      (network fee ≈ 0.002 ALGO)".
- [ ] Per-action fee disclaimers beside every money-moving button (refund, cancel
      pledge, batch refund). See `docs/frontend.md` → "Refund UX & fee disclaimers".
- [ ] **Batch refund ("Refund all")** — `refundBatch` sweep of up to 8 backers per
      call, driven by the creator or anyone (permissionless), looped until the escrow
      is drained.

### Cancel

- [ ] **Cancel pledge before the deadline** — `cancelPledge` lets a backer withdraw
      (with the ≈ 0.002 ALGO fee) while the campaign is `Open`.
- [ ] **Cancel-before-deadline for creators** — a creator cancels a stalled campaign.

### Metadata & content

- [ ] Rich off-chain rendering (IPFS image/description/category) — `title` +
      `metadataUri` are implemented; rendering the JSON blob is still to do.
- [ ] `updateMetadata()` (optional) — creator re-points metadata; needs a contract
      change, so it must land **before** TestNet/MainNet deploy (see
      [Contract versioning](#contract-versioning-and-migration)).

### CI & packaging

- [ ] CI coverage gate + lint/format/type-check gate + frontend image build
      (the consolidated `build-and-test` workflow is done; frontend image build remains).
- [ ] Package the frontend as a container image for portable hosting.
- [ ] ARC-32/56 spec published for the contract.

## Proposed contract changes

Documented for design alignment; **not yet implemented**. Each is described in
`docs/contracts/campaign.md` under its own method heading.

| Method | Purpose | Caller | Fee (≈) |
| --- | --- | --- | --- |
| `cancelPledge()` | Withdraw a pledge while `Open` | Backer with a pledge box | 0.002 ALGO |
| `refundBatch(backers…)` | Refund up to 8 backers at once | Anyone (permissionless) | 0.009 ALGO |
| `settle()` (open question) | Flip status after deadline with zero backers | Anyone | 0.001 ALGO |

- `cancelPledge` mirrors Kickstarter's "not charged until the deadline" model; it
  makes `raised` revocable while `Open` (see design decision 9).
- `refundBatch` exists because a contract cannot enumerate its own boxes or refund
  everyone "automatically" — someone must always submit the transactions.
- `settle` is only needed to close the cosmetic gap where a zero-pledge campaign never
  materialises `Failed` on-chain (see edge case 1 below).

## Known edge cases & open questions

Full detail lives with the code it concerns:

- **Contract** — [`contracts/campaign.md`](contracts/campaign.md) → "Known edge cases".
- **Frontend** — [`frontend.md`](frontend.md) → "Edge cases & gotchas".

The ones that require a **code decision** before implementing the proposed methods:

1. **Zero-pledge campaign stuck in `Open`.** `refund()` requires the caller's box to
   exist and the whole call is atomic, so a campaign nobody pledged to never records
   `Failed` on-chain. The UI still derives "failed", so it's cosmetic — but decide
   whether to add `settle()`.
2. **Stray ALGO sent directly to the escrow.** Not in any box: on success it goes to
   the creator for free; on failure it's stranded after all refunds. Document and accept.
3. **`refundBatch` poisoning.** One bad/duplicate address reverts the whole batch; the
   frontend must dedupe and pass only live box addresses.
4. **Opcode budget.** 8 inner payments + 8 box references approach the app-call budget;
   verify it compiles, drop to 6–7 if not.
5. **Re-pledge → cancel → re-pledge.** The box must be recreated with the fresh amount
   and `raised` re-incremented correctly (needs a test once `cancelPledge` exists).
6. **Deadline boundary.** `latestTimestamp < deadline` opens pledging and
   `latestTimestamp >= deadline` opens claim/refund — test the `==` boundary explicitly.

## Later product phases

Working design for turning the dApp into something that feels like a real product.
This is a **plan**, not code; nothing here is implemented.

### Phase A — content & UI (no backend, no outcome-logic change)

- [ ] Design tokens, layout, nav, account page shell.
- [ ] "Your projects" / "Your pledges" views (indexer queries only).
- [ ] Rich campaign content (see Phase 4 → Metadata & content).

### Phase B — profiles & notifications (introduces a minimal backend)

- [ ] Minimal API + DB for profiles and email settings.
- [ ] Wallet-signed attestation for profile binding.
- [ ] Chain watcher → email on funded/failed/deadline events.
- [ ] Account page wired to the backend.

### Phase C — polish

- [ ] Image pinning to IPFS (service or self-hosted node).
- [ ] Backers list, creator page, category filters, analytics.
- [ ] PWA + web push notifications.
- [ ] Trust & safety (report/block).

### Accounts and identity

There is no account system today — a "user" is just an Algorand address. The wallet
**is** the account; do **not** build a username/password system. Add an optional
**profile layer** on top (display name, avatar, email, bio) keyed by wallet address,
living off-chain. The address→profile binding is proven by a **signed attestation**
(same pattern as login-with-wallet), so no private key is ever seen.

### Where personal info lives

| Data | Where | Why |
| --- | --- | --- |
| Address, public key | On-chain / indexer | Already public by design |
| Campaign title | On-chain global state | Cheap, listable without extra lookups |
| Campaign description, image, category | Off-chain JSON (IPFS) | Rich content, cheap to re-point |
| Display name, avatar, bio | Off-chain DB | Not needed by the contract |
| Email address | Off-chain DB, never indexed publicly | Privacy; used only for notifications |
| Notification preferences | Off-chain DB | Privacy + user control |
| Pledge history | On-chain (boxes) | Source of truth for refunds |
| "Your campaigns / your pledges" | Derived from indexer | No extra storage |

**Rule of thumb:** if the contract doesn't need it to enforce a rule, don't put it
on-chain.

### Notifications (email / push)

The contract enforces outcomes but cannot send email. The trigger is always an
**on-chain state change**; delivery is always **off-chain**:

1. A watcher observes the chain (indexer polling, hosted-indexer webhook, or algod
   block subscriptions).
2. It detects transitions (funded / failed / new pledge) and maps the affected
   addresses to profiles with emails.
3. It sends via a provider (Resend, Postmark, SES) or web-push.

**Notifications are the one feature that genuinely needs a backend** — sending email
requires a server-side secret and a chain watcher; a static frontend cannot do this.

### Do we need a real backend?

Short answer: **not for the core product, yes for a few features.**

| Feature | Needs backend? | Notes |
| --- | --- | --- |
| Browse/pledge/claim/refund | No | Contract + indexer (today) |
| Campaign title/description/images | No (IPFS) + a pinning service | Optional API to pin to IPFS |
| Notifications (email/push) | **Yes** | Server secret + chain watcher |
| Profiles (name/avatar/email) | Yes | A database |
| Creator dashboard / "my projects" | No | Derive from indexer |
| Analytics (views, conversion) | Yes | If we care about page views |
| Moderation / abuse reporting | Yes | Trust & safety |

Stay **serverless/static** as long as possible; when notifications and profiles land,
introduce a **minimal backend** (a small API + a database) that holds only profile +
notification data. It never holds keys, funds, or outcome decisions.

### Creator section, account page, navigation

Persistent top bar: **Browse**, **Start a project**, **Account**, **Your projects**,
**Your pledges**, plus the wallet badge. "Your projects" and "Your pledges" are pure
indexer queries filtered by the connected address — no new storage.

### Campaign content (title, description, images)

The hybrid approach is **implemented** (see `docs/frontend.md`): short `title`
on-chain, `metadataUri` pointing to an IPFS JSON blob with description/image/category.
`title` is immutable; re-pointing `metadataUri` needs an `updateMetadata()` method
(contract change — see [Contract versioning](#contract-versioning-and-migration)).

### UI / design work

1. **Design system** — a small token set (colors, type, spacing, radius, shadows)
   centralized in CSS variables or a Tailwind theme.
2. **Layout** — persistent header, max-width content column, consistent spacing.
3. **Campaign cards** — title, image, progress bar, raised/goal, time left, status badge.
4. **Detail page** — hero image, story, creator block, pledge panel, progress.
5. **Create flow** — real form (title, story, image, goal, duration, preview).
6. **States** — empty, loading, error, success/confirmation toasts.
7. **Accessibility** — focus states, labels, keyboard nav, reduced motion.

Order: tokens + layout first, then cards/detail, then forms and states.

### Contract versioning and migration

Deployed AVM apps are immutable, so every contract change is a **new app version**:

- Keep an app spec (ARC-32/56) per deploy; tag releases; record which app ID came from
  which version.
- **Old campaigns keep running on old code; new campaigns use the new code.** No
  migration of live campaigns needed.
- The painful case is changing a live, funded campaign's logic — we cannot patch it.
  Mitigation: freeze contract logic before real value is at risk, and TestNet-test
  aggressively.

If a long-lived singleton ever appears (registry, fee collector, profile attestation
ledger), consider a **proxy contract** pattern to enable upgrades. Not needed now.

### Open questions to decide (product)

1. **Email provider & deliverability** — Resend vs Postmark vs SES; require email verification?
2. **Which notification events** are in scope for v1 (funded + failed are the essentials)?
3. **Creator identity verification** — do we need KYC, and at what stage?
4. **IPFS pinning** — hosted service (Pinata/web3.storage) or our own node?
5. **Backend hosting** — Cloudflare Workers + D1/Supabase, or Node + Postgres?
6. **Fees** — does the platform ever take a cut (a `fee` in the contract), and how?
