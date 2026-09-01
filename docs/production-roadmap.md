# Production roadmap — identity, backend, notifications, UI

This document is a working design for turning the Phase 1/2 dApp into something that
feels like a real product. It answers the open questions raised during review:

- How do real people (creators and backers) get accounts?
- Where does personal info live?
- How do we email/notify people when a campaign is funded or a deadline passes?
- Do we need a backend at some point?
- How do we add a creator section, an account page, and "your projects / your pledges"?
- How do we fix the UI and add title/description/images to campaigns?

It is a **plan**, not code. Nothing here is implemented yet.

## Guiding principle

Keep the parts that matter on-chain **on-chain**, and keep the parts that are
personal/private **off-chain**. Concretely:

- **Money, escrow, and outcome rules** — always on-chain (already true).
- **Campaign identity** (title, description, image) — hybrid: short title on-chain
  (**implemented**), long content off-chain (see `docs/frontend.md`).
- **Email addresses, notification preferences, profiles** — off-chain only. Never
  on-chain, never in the contract.

This keeps the contract auditable and the dApp's privacy surface small.

## 1. Accounts and identity

### Today

There is no account system. A "user" is just an Algorand address. The wallet popup
gives us the address, and we build everything else from the chain.

### The two kinds of "account"

**1. The wallet account (the cryptographic identity).** This is the non-negotiable
base layer. It is what signs transactions, what holds funds, what owns campaigns and
pledges. This stays exactly as it is.

**2. The profile (the human-facing identity).** This is a display name, an avatar, an
email address, notification preferences. It is optional, can be created later, and can
be changed. It is attached to the wallet address.

### Recommendation

Do **not** build a username/password system. The wallet **is** the account. Add an
optional **profile layer** on top:

- On first connect, the user is "anonymous" — everything still works.
- They can optionally claim a profile: display name, email (for notifications),
  avatar, and a short bio.
- Profile is keyed by wallet address and lives off-chain (see §2).

### How a user proves they own a profile

Since there is no server trust, the profile is linked to the address by a **signed
attestation**: the user signs a message ("I am creating this profile") with their
wallet, and the backend stores the profile against the public key/address. Same pattern
as login-with-wallet. This gives us a verified address→profile binding without ever
seeing a private key.

## 2. Where personal info lives

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
on-chain. Personal info is off-chain in a normal database, protected by the same
privacy practices as any web app.

## 3. Notifications (email / push)

### The problem

The contract enforces outcomes, but it cannot send email. "Your campaign reached its
goal" and "the deadline passed and you were refunded" are **off-chain events that we
derive by watching the chain**.

### The mechanism

The trigger is always **on-chain state change**; the delivery is always **off-chain**.

1. A **watcher/worker** observes the chain (indexer polling, or a webhook from a
   hosted indexer like AlgoExplorer/NFD, or `algod` block round subscriptions).
2. It detects transitions:
   - deadline passed and `raised >= goal` → "campaign funded" (creator + backers)
   - deadline passed and `raised < goal` → "campaign failed / refund available" (backers)
   - new pledge → "you backed X" (backer)
3. It looks up who needs to be told (creator address, backer addresses from boxes) and
   maps them to profiles with emails.
4. It sends the notification through a provider (Resend, Postmark, SES) or push
   (web-push if we add a PWA).

### Do we need a backend for this?

Yes — **notifications are the one feature that genuinely needs a backend**, because
sending email requires a server-side secret (the API key) and someone to watch the
chain. A static frontend cannot do this.

### Minimal viable design

- A small worker (cron or long-running) that polls the indexer for campaigns whose
  deadline just passed, computes the outcome, and enqueues emails.
- A `users` table: `address`, `email`, `preferences` (opt-in per event type).
- Every email has an unsubscribe link (legally required in most places).

## 4. Do we need a real backend?

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

Recommendation: stay **serverless/static** as long as possible. When we add
notifications and profiles, introduce a **minimal backend** — a small API (e.g. a
Node/Cloudflare Worker) plus a database (Postgres or a hosted store). It holds only
profile + notification data. It never holds keys, never holds funds, never decides
outcomes.

## 5. Creator section, account page, navigation

### Menu structure

A classic persistent top bar, replacing the current minimal nav:

- **Browse** (home) — all campaigns.
- **Start a project** — the create form (gated: wallet must be connected).
- **Account** — profile settings, notification preferences.
- **Your projects** — campaigns the connected address created.
- **Your pledges** — campaigns the connected address backed, with pledge amount and
  status (open / funded / refunded).
- **Wallet connect / address badge** — stays in the corner.

### "Your projects" and "Your pledges" — no new storage needed

Both are **queries against the indexer**, filtered by the connected address:

- Your projects = applications where global-state `creator == activeAddress`.
- Your pledges = campaigns where a backer box for `activeAddress` exists (the box
  prefix `p` + address).

This is the same read path the app already uses (`lib/campaign.ts`); we just add a
filtered view. No backend required.

### Account page

- Display name, avatar, bio (off-chain profile).
- Email + notification toggles (off-chain).
- Linked wallet address (read-only, from the wallet).
- Maybe: "export my data" (address + profiles + emails).

## 6. Campaign content (title, description, images)

The hybrid approach is now **implemented** (see `docs/frontend.md`):

- **On-chain:** `title` (bytes) in global state, set at `create()`.
- **Off-chain:** `metadataUri` (bytes) pointing to a JSON blob on IPFS with
  description, image, category, and long text.

### What this means for the contract

`create(title, metadataUri, goal, deadline)` stores all four in global state.
`title` is immutable; `metadataUri` could be re-pointed later by the creator (a
small, optional `updateMetadata()` method — needs a contract change, so it must
land **before** a TestNet/MainNet deploy or we redeploy).

### What this means for the frontend

- `CampaignViewModel` exposes `title` and `metadataUri`.
- Browse cards render `title` straight from the indexer — no IPFS round-trip.
- Detail view shows `title` and the `metadataUri`; fetching and rendering the
  IPFS JSON for description/image remains Phase 4.
- Create form has Title and Metadata URI fields (description/upload still pending).

### Category & discovery

Optionally store a `category` enum (on-chain `uint64` or in the metadata JSON).
On-chain is better for filtering lists without fetching IPFS.

## 7. UI / design work

The current UI is the AlgoKit starter's Tailwind/daisyUI look. To look like a real
product:

1. **Design system** — pick a small token set: colors (primary/accent/success/danger),
   typography scale, spacing, radius, shadows. Centralize in CSS variables or a
   Tailwind theme. One place to change everything.
2. **Layout** — persistent header with nav, a max-width content column, consistent
   spacing between sections.
3. **Campaign cards** — title, image, progress bar, raised/goal, time left, status
   badge. Images make the browse page feel real.
4. **Detail page** — hero image, story text, creator block, pledge panel, backers
   list (if we add it), progress.
5. **Create flow** — a real form: title, story/description, image upload, goal,
   duration, preview before submitting the on-chain `create()`.
6. **States** — empty states, loading skeletons, error states, success/confirmation
   toasts after transactions.
7. **Accessibility** — focus states, labels, keyboard nav, reduced motion.

**Order of work:** tokens + layout first (biggest visual win), then cards/detail, then
forms and states.

## 8. Data model changes summary

### Contract (on-chain)

| Change | Type | Notes |
| --- | --- | --- |
| `title: bytes` global state | **Implemented** | Set at create, immutable |
| `metadataUri: bytes` global state | **Implemented** | Off-chain JSON pointer |
| `category` (optional) | New | `uint64` enum or in metadata |
| `updateMetadata()` (optional) | New | Creator re-points metadata |

`title`/`metadataUri` change the ABI, so they are a **new contract version** (see §9).
`category`/`updateMetadata()` are still future work.

### Off-chain (backend, when introduced)

| Table | Purpose |
| --- | --- |
| `profiles` | `address`, `displayName`, `avatar`, `bio`, timestamps |
| `notification_settings` | `address`, `email`, per-event toggles |
| `events` (optional log) | observed chain events → notification queue |

## 9. Contract versioning and migration

Because deployed AVM apps are immutable (§"redeploying" discussion), every contract
change means a new app version:

- **Versioning:** keep an app spec (ARC-32/56) per deploy; tag releases; record which
  app ID came from which version.
- **Old campaigns keep running on old code.** New campaigns use the new code. This is
  a feature, not a bug — no migration of live campaigns needed.
- **The only painful case:** changing the logic of a campaign that is already live and
  funded. We cannot patch it. Mitigation is to freeze contract logic before putting
  real value at risk, and to TestNet-test aggressively (see roadmap below).

If a long-lived singleton ever appears (a registry, a platform fee collector, a profile
attestation ledger), consider a **proxy contract** pattern (a thin app that delegates
to a configurable implementation app ID) to enable upgrades. Not needed now.

## 10. Phased plan

### Phase A — content & UI (no backend, no contract change to outcome logic)

- Add `title`/`metadataUri` to the contract + create form + cards + detail. (**done**)
- Design tokens, layout, nav, account page shell.
- "Your projects" / "Your pledges" views (indexer queries only).

### Phase B — profiles & notifications (introduces the backend)

- Minimal API + DB for profiles and email settings.
- Wallet-signed attestation for profile binding.
- Chain watcher → email on funded/failed/deadline events.
- Account page wired to the backend.

### Phase C — polish

- Image pinning to IPFS (service or self-hosted node).
- Backers list, creator page, category filters, analytics.
- PWA + web push notifications.
- Trust & safety (report/block).

## 11. Open questions to decide

1. **Email provider & deliverability** — Resend vs Postmark vs SES; do we require
   email verification?
2. **Which notification events** are in scope for v1 (funded + failed are the
   essentials)?
3. **Creator identity verification** — do we need it (KYC is a legal question, not
   technical), and at what stage?
4. **IPFS pinning** — use a hosted service (Pinata/web3.storage) or run our own node?
5. **Backend hosting** — Cloudflare Workers + D1/Supabase, or a traditional Node +
   Postgres service?
6. **Fees** — does the platform ever take a cut (a `fee` in the contract), and how is
   that decided?
