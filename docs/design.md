# Product design & open questions

Where AlgorArt is headed beyond the current contract + frontend: identity,
profiles, notifications, the backend question, content, UI work, and contract
versioning. This is a **plan**, not code — nothing here is implemented unless
noted.

> Contract internals: [`campaign.md`](campaign.md). Frontend
> design: [`frontend.md`](frontend.md). CI: [`ci.md`](ci.md). Roadmap:
> [`roadmap.md`](roadmap.md). Backend/catalog & archival:
> [`architecture.md`](architecture.md).

## Guiding principle

Keep the parts that matter on-chain **on-chain**, and keep the parts that are
personal/private **off-chain**:

- **Money, escrow, and outcome rules** — always on-chain (already true).
- **Campaign identity** (title, description, image) — hybrid: short title on-chain
  (**implemented**), long content off-chain (see [`frontend.md`](frontend.md)).
- **Email addresses, notification preferences, profiles** — off-chain only. Never
  on-chain, never in the contract.

This keeps the contract auditable and the dApp's privacy surface small.

## Accounts and identity

There is no account system today — a "user" is just an Algorand address. The wallet
**is** the account; do **not** build a username/password system. Add an optional
**profile layer** on top (display name, avatar, email, bio) keyed by wallet address,
living off-chain. The address→profile binding is proven by a **signed attestation**
(same pattern as login-with-wallet), so no private key is ever seen.

## Where personal info lives

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

## Creator section, account page, navigation

Persistent top bar: **Browse**, **Start a project**, **Account**, **Your projects**,
**Your pledges**, plus the wallet badge. "Your projects" and "Your pledges" are pure
indexer queries filtered by the connected address — no new storage.

## Campaign content (title, description, images)

Content is hybrid and already implemented (see [`frontend.md`](frontend.md)): a
short on-chain `title`, with the long description/image/category off-chain behind
`metadataUri`. `title` is immutable; re-pointing `metadataUri` needs an
`updateMetadata()` method — a contract change that must land **before** any
"final" deploy (see [Contract versioning](#contract-versioning-and-migration)).

## UI / design work

1. **Design system** — a small token set (colors, type, spacing, radius, shadows)
   centralized in CSS variables or a Tailwind theme.
2. **Layout** — persistent header, max-width content column, consistent spacing.
3. **Campaign cards** — title, image, progress bar, raised/goal, time left, status badge.
4. **Detail page** — hero image, story, creator block, pledge panel, progress.
5. **Create flow** — real form (title, story, image, goal, duration, preview).
6. **States** — empty, loading, error, success/confirmation toasts.
7. **Accessibility** — focus states, labels, keyboard nav, reduced motion.

Order: tokens + layout first, then cards/detail, then forms and states.

## Notifications (email / push)

The contract enforces outcomes but cannot send email. The trigger is always an
**on-chain state change**; delivery is always **off-chain**:

1. A watcher observes the chain (indexer polling, hosted-indexer webhook, or algod
   block subscriptions).
2. It detects transitions (funded / failed / new pledge) and maps the affected
   addresses to profiles with emails.
3. It sends via a provider (Resend, Postmark, SES) or web-push.

**Notifications are the one feature that genuinely needs a backend** — sending email
requires a server-side secret and a chain watcher; a static frontend cannot do this.

## Do we need a real backend?

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

## Contract versioning and migration

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

## Open questions to decide (product)

1. **Email provider & deliverability** — Resend vs Postmark vs SES; require email verification?
2. **Which notification events** are in scope for v1 (funded + failed are the essentials)?
3. **Creator identity verification** — do we need KYC, and at what stage?
4. **IPFS pinning** — hosted service (Pinata/web3.storage) or our own node?
5. **Backend hosting** — Cloudflare Workers + D1/Supabase, or Node + Postgres?
6. **Fees** — does the platform ever take a cut (a `fee` in the contract), and how?
