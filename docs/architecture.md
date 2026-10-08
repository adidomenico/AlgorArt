# Architecture

How AlgorArt is put together: the **escrow** (Campaign + Merkle tree), the **ClaimsVault** (the pooled refund escrow),
the **Factory** (canonical registration), and the optional **catalog** for discovery and archival.

> Contract internals: [`campaign.md`](campaign.md) and
> [`claim-tree-protocol.md`](claim-tree-protocol.md) (the Claim ASA design in
> [`claim-asa-redesign.md`](claim-asa-redesign.md) is superseded history).
> Frontend design: [`frontend.md`](frontend.md). Product design & open questions:
> [`design.md`](design.md). Roadmap: [`roadmap.md`](roadmap.md).

## Built with

| Layer | Technology |
| --- | --- |
| Smart contracts | **Algorand TypeScript** (`@algorandfoundation/algorand-typescript`) → AVM |
| Frontend | **React + Vite + TypeScript**, **Tailwind CSS** |
| Wallet (non-custodial) | **`@txnlab/use-wallet`** → Pera / Defly / Exodus |
| SDK / reads | **`algosdk`**, **Algorand Indexer** |
| Off-chain metadata | **IPFS** (ARC-3-style JSON, Pinata gateway + pinning) |
| Testing | **AVM simulator** (offline) + **LocalNet** integration (Vitest) |
| Tooling | **AlgoKit CLI** + local sandbox (Docker) |
| Backend | **None required** - contract + indexer + Factory replace it (a catalog is optional) |

## Repository layout

AlgoKit's standard **workspace** layout (what `algokit init` produces and the CLI expects):

```text
AlgorArt/
├── projects/
│   ├── contracts/                # AlgoKit contract project (TypeScript)
│   │   ├── smart_contracts/
│   │   │   ├── campaign/         # the escrow app + Merkle tree
│   │   │   ├── factory/          # the canonical campaign registry
│   │   │   ├── claimsvault/      # the pooled refund escrow
│   │   │   └── index.ts          # deploy orchestrator
│   │   └── scripts/              # seed-demo / unseed-demo (demo data + cleanup)
│   └── frontend/                 # React + Vite + TypeScript dApp
│       └── src/
│           ├── features/         # app shell, campaigns (browse/detail/create), wallet UI
│           ├── lib/              # algod/indexer config, campaign/transaction/metadata helpers
│           └── styles/           # Tailwind theme tokens
├── docs/                         # technical docs (this directory)
└── demo-metadata/                # local campaign-metadata payloads (gitignored, never committed)
```

## The pieces

| | Campaign escrow (per campaign) | ClaimsVault (one, platform-owned) | Factory (one, platform-owned) | Catalog (optional backend) |
| --- | --- | --- | --- | --- |
| What it is | Campaign app + app account + Merkle tree | Permanent pooled refund escrow | On-chain registry app | API + DB |
| Funds it holds | Nothing - not even a creator deposit | All backers' pledged ALGO, pooled | Registration deposits | none |
| Lifecycle | Created per campaign; deleted after settlement | Permanent | Permanent | Permanent |
| Job | Enforce crowdfunding rules; append/null leaves | Pay refunds/cancels/claims; settle; finalize | Prove a campaign is official AlgorArt | Browse/search/archive |

### The campaign escrow: no funds, no per-backer storage

Each campaign is an isolated application whose escrow is never funded. Backers' pledges go to the vault; the campaign's
own storage (10 global keys) never grows with the backer count, and both settlement paths finalize in O(1). Full
internals: [`campaign.md`](campaign.md).

### The ClaimsVault: pooled custody, constant-bounded finalization

The vault is a permanent platform app that:

1. **Records each campaign's inflows** (`credit`, permissionless but payment-verified, Factory registration verified
   on-chain via an inner call to `isRegistered` on first touch). An unregistered campaign can never park the vault's
   minimum balance.
2. **Holds all pledged ALGO** in one pooled account. Solvency is by per-campaign balance guards, not bookkeeping:
   every payout asserts `amount ≤ paidIn − paidOut` for its own box, so no campaign can ever drain another's funds.
3. **Pays out** on the campaign's authority (`payBack`, `payClaim`, `settle` - inner-call-gated to the campaign's own app
   account) and **serves refunds directly** after a failed settlement (`refund(app, k, amount, txid, path)`, verified
   against the settled root) - inside the refund window, including after the campaign app is deleted.
4. **Finalizes** (`finalize` once the window closes) to sweep residuals to the sweep target and release the campaign's
   32,100 µA parked box MBR - optional, permissionless, off any critical path. `settle` also covers the **stray**
   case (a no-pledge inflow with no campaign tree), so stray funds become finalizable instead of stranded.

The vault is the honest concentration of trust: one audited, non-updatable contract holds all campaign funds. See
[`claim-tree-protocol.md`](claim-tree-protocol.md) for the security analysis and the accepted parked-MBR economics.

### The Factory: canonical registration, not shared custody

The Factory is the on-chain **registry**, unchanged in role: it verifies a new campaign app against the owner-configured official
approval-program hash and records `app id → creator` against a refundable deposit. It holds no campaign funds and takes no part in
pledging, refunding, or cleanup. The ClaimsVault checks Factory registration on each campaign's first touch, so an unregistered
campaign can never park the vault's minimum balance.

## Creation flow

1. The creator signs the Campaign `create(vault, …)` - one app-create transaction. Nothing is funded.
2. The creator registers with the Factory (≈ 0.019 ALGO refundable deposit) - **required**: the vault's first-touch `credit`
   verifies the registration on-chain.

The frontend chains 1–2 into a single user action ([`frontend.md`](frontend.md)).

## Settlement flows (no backend involved)

- **Success:** creator calls `claim()` (the vault pays the derived live total and records the claimed settlement); the creator
  `delete()`s in O(1), releasing the vault box.
- **Failure:** each backer refunds one leaf at a time - through the campaign while it lives; the creator `delete()`s in O(1)
  (recording the failed settlement with root/N), after which backers refund **directly from the vault until the refund window
  closes**. Then anyone calls `finalize()` (residual to the sweep target, box released).
- **Abandoned (never pledged):** the creator can `delete()` immediately (settle no-ops without a box).

None of these paths iterates backers on the platform's behalf.

## References

Official Algorand docs backing the claims in this file (verify against these when in doubt):

- [Applications](https://dev.algorand.co/concepts/smart-contracts/apps/) - app lifecycle and deletion.
- [Indexer REST API](https://dev.algorand.co/reference/rest-api/indexer/) - application `deleted` / `deleted-at-round` fields,
  `include-all`, box lookups.
