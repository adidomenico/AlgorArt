# Architecture

This page describes the system pieces, the campaign lifecycle, and the tech stack. The contract reference is in [`campaign.md`](campaign.md); the tree math is in [`claim-tree-protocol.md`](claim-tree-protocol.md).

AlgorArt is a non-custodial crowdfunding dApp on Algorand. Creators open campaigns with a goal and a deadline; backers pledge ALGO from their own wallets. The UI never holds funds or keys. It reads state from the indexer and builds transaction groups that the wallet signs.

## Pieces

| Piece | Type | Role |
| --- | --- | --- |
| Campaign app | One stateful app per campaign | Enforces rules; tracks the Merkle root; holds no funds |
| ClaimsVault | One permanent app, platform-owned | Holds all pledged ALGO pooled; pays cancels, refunds, and claims |
| Factory | One registry app, platform-owned | Registers official campaigns against the owner-configured approval hash |
| Frontend | React + Vite + TypeScript | Browse, create, pledge, claim, refund; wallet via Pera / Defly / Exodus (KMD on LocalNet) |
| Catalog (optional) | Fastify + Postgres | Profiles, IPFS pinning, search and history UX |

Users and wallets never appear as a piece: any Algorand address with a wallet is a creator or backer. No account system exists.

## Creation flow

To open a campaign, complete these steps in order:

1. Deploy a Campaign app with the vault, title, metadata URI, goal, and deadline.
2. Fund the app's minimum balance (about 0.2 ALGO plus the registration deposit).
3. Register the app in the Factory to mark it official.
4. Share the app ID so backers find it through the Factory listing.

The frontend chains steps 1 through 3 into a single user action (see [`frontend.md`](frontend.md)).

## Escrow and vault

Campaign escrows are never funded and hold nothing. Every pledge payment goes to the vault app account. Each pledge appends one receipt leaf to the campaign's incremental Merkle tree ([`claim-tree-protocol.md`](claim-tree-protocol.md)) and records the inflow in the vault's per-campaign box. There is no per-backer on-chain state anywhere.

The vault account therefore holds the full pool of live pledges plus parked box minimum balances (32,100 µA per live or failed campaign box). Every outflow passes a balance guard: a payout never exceeds the campaign's verified inflows minus its verified outflows.

## Settlement flows

| Path | Trigger | Effect |
| --- | --- | --- |
| Success | Creator calls `claim()` after the deadline with the goal met | Vault pays the creator the full live total; the box closes as `Claimed` |
| Failure | First `refund()` after the deadline with the goal missed | Box settles as `Failed`; each backer refunds their own leaves from the vault |
| Pre-deadline exit | Backer calls `cancelPledge()` while the campaign is open | Leaf nulls in place; vault pays the backer |
| Creator delete | Creator calls `delete()` on a settled campaign | Settles through the vault, closes the escrow, unregisters from the Factory |

Both settlement paths finalize in O(1) time and cost. Refunds stay available for 730 days after settlement then a permissionless `finalize()` sweeps the residual to the configured treasury. A backer who never acts before deletion refunds straight from the vault with the same proofs.

## Optional catalog

The Factory plus the indexer already cover discovery (which campaigns exist) and the outcome record (what happened). The catalog exists for search, filter, and history UX: profiles, settings, server-side IPFS pinning, and a per-campaign row finalized by a chain watcher. It never holds keys, funds, or outcome decisions. Without it the dApp still runs.

## Tech stack

| Layer | Choice |
| --- | --- |
| Contracts | Algorand TypeScript (PuyaTs) via AlgoKit, TEAL + ARC-32/56 specs as build output |
| Client SDK | AlgoKit Utils `AlgorandClient` + generated typed clients |
| Wallet | `@txnlab/use-wallet` (Pera, Defly, Exodus; KMD on LocalNet) |
| Reads | `algosdk.Indexer` for app state, boxes, and transaction history |
| Frontend tests | Vitest + Testing Library, 100% gate on components and utils |
| Contract tests | Offline AVM emulation plus LocalNet integration (see [`testing.md`](testing.md)) |
| CI | One `build-and-test` workflow plus a separate `markdown-lint` workflow (see [`ci.md`](ci.md)) |

## Constraints

- Discovery needs no backend. The Factory registry plus the indexer answer "which campaigns exist" today.
- The contract is the source of truth. The frontend computes display status from the same public state, and the contract assertions decide.
- Pledge-time content stays frozen. `title` and `metadataUri` are immutable, so a pledge can never be re-described under the backer. Corrections ship through the creator updates feed (see [`design.md`](design.md)).
