# AlgorArt

Non-custodial crowdfunding on Algorand. Creators open a campaign with a goal and a deadline, backers pledge real ALGO from their own wallets, and a smart contract enforces the outcome: goal met, the creator claims; otherwise every backer reclaims their pledge.

Crowdfunding is a trust problem. Funds lock in a contract instead of the creator's pocket, the raise X by date Y or refund everyone rule runs on-chain, and every pledge, total, and deadline stays public. Algorand fits because finality takes about 4 seconds and fees sit near 0.001 ALGO.

You keep your keys. You connect Pera, Defly, or Exodus, the app only sees signed transactions, and the chain stays the source of truth.

## Features

| Feature | What you get |
| --- | --- |
| Trustless escrow | No custodian holds funds, the contract enforces claim or refund |
| Proof-based refunds | Each pledge is a Merkle leaf, each refund is a proof, no per-backer storage |
| O(1) settlement | Success and failure paths finalize in constant time and cost |
| Post-delete refunds | Backers refund straight from the vault after the campaign app is gone |
| Factory registry | Only hash-verified campaigns accept pledges |
| Refund window | Failed pledges stay reclaimable for 730 days, then a sweep target collects dust |

## How it works

| Piece | Job |
| --- | --- |
| Campaign app (one per campaign) | Enforces rules, appends and nulls Merkle leaves, holds no funds at all |
| ClaimsVault (one, platform-owned) | Holds all pledged ALGO pooled, pays cancels, refunds, and claims |
| Factory (one, platform-owned) | Registers official campaigns against the owner-configured approval hash |
| Frontend | Reads state from the indexer, builds transaction groups for your wallet |

A pledge is one atomic group: payment to the vault, campaign leaf append, vault inflow record. A refund rebuilds the leaf from your address, amount, and payment ID, verifies it against the stored root, nulls it in place, and pays you back. Details live in [`docs/architecture.md`](docs/architecture.md) and [`docs/campaign.md`](docs/campaign.md).

## Quick start

You need Node.js LTS (v22 or newer), Docker (LocalNet only), and the AlgoKit CLI.

```bash
algokit project bootstrap all  # install deps for contracts, frontend, backend
algokit localnet start         # start algod + indexer in Docker

cd projects/contracts
npm run build                  # compile contracts + generate typed clients
npm run deploy:ci -- factory   # deploy the Factory (prints the app id)
FACTORY_APP_ID=<factory id> npm run deploy:ci -- claimsvault
FACTORY_APP_ID=<factory id> VAULT_APP_ID=<vault id> npm run seed  # demo data

cd ../frontend
# set VITE_FACTORY_APP_ID=<factory id> and VITE_VAULT_APP_ID=<vault id> in .env
npm run dev                    # frontend on http://localhost:5173
```

The backend is optional (profiles, pinning, catalog). It runs as a separate service:

```bash
cd ../backend
cp .env.template .env  # then fill SESSION_SECRET (openssl rand -hex 32)
docker compose up -d   # Postgres on localhost:5432
npm run db:migrate      # apply migrations
npm run dev             # API on http://127.0.0.1:3001
```

## Docs

| Doc | Covers |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | Pieces, creation and settlement flows, tech stack |
| [`docs/campaign.md`](docs/campaign.md) | Campaign contract reference: state, methods, fees |
| [`docs/claim-tree-protocol.md`](docs/claim-tree-protocol.md) | Claim-tree math, proofs, and security analysis |
| [`docs/frontend.md`](docs/frontend.md) | UI structure, wallet, reads, writes, metadata |
| [`docs/testing.md`](docs/testing.md) | Contract and frontend test strategy |
| [`docs/ci.md`](docs/ci.md) | GitHub Actions workflows and checks |
| [`docs/conventions.md`](docs/conventions.md) | Lint, format, and TypeScript rules |
| [`docs/roadmap.md`](docs/roadmap.md) | What is done and what is left |
| [`docs/design.md`](docs/design.md) | Product decisions and open questions |

Agent guidance (commands, gotchas, definition of done) lives in [`AGENTS.md`](AGENTS.md).

## Status

Live on TestNet: Factory `773811780`, ClaimsVault `773811800`. [`docs/roadmap.md`](docs/roadmap.md) tracks current work.

## License

Demo project for educational purposes.
