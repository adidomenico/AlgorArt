# AlgorArt

Non-custodial crowdfunding on Algorand. Creators open campaigns with a funding goal and a deadline; backers pledge ALGO from their own wallets. The contract enforces the outcome: if the goal is met by the deadline, the creator claims the total, otherwise each backer refunds their own pledge.

Pledged funds lock in the contract, not with the creator. Campaign state (pledged total, deadline, outcome) is public and on-chain. The application is non-custodial: it handles signed transactions only and never holds keys or funds.

## Features

| Feature | Description |
| --- | --- |
| Trustless escrow | No custodian holds funds; the contract enforces claim or refund |
| Proof-based refunds | Each pledge is a Merkle leaf; each refund is a proof; no per-backer storage |
| O(1) settlement | Success and failure paths finalize in constant time and cost |
| Post-delete refunds | Backers refund from the vault after the campaign app is deleted |
| Factory registry | Only hash-verified campaigns accept pledges |
| Refund window | Failed pledges stay reclaimable for 730 days, then residual goes to a sweep target |

## How it works

| Piece | Responsibility |
| --- | --- |
| Campaign app (one per campaign) | Enforces rules; appends and nulls Merkle leaves; holds no funds |
| ClaimsVault (one, platform-owned) | Holds all pledged ALGO pooled; pays cancels, refunds, and claims |
| Factory (one, platform-owned) | Registers campaigns against the owner-configured approval hash |
| Frontend | Reads state from the indexer; builds transaction groups for the wallet |

A pledge is one atomic group: payment to the vault, campaign leaf append, vault inflow record. A refund rebuilds the leaf from address, amount, and payment ID, verifies it against the stored root, nulls it in place, and pays the backer. See [`docs/architecture.md`](docs/architecture.md) and [`docs/campaign.md`](docs/campaign.md).

## Quick start

Prerequisites: Node.js LTS (v22 or newer), Docker (LocalNet only), AlgoKit CLI.

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

The backend is an optional user service (wallet-signature auth plus profiles/settings storage; pinning and catalog are planned) and runs as a separate service:

```bash
cd ../backend
cp .env.template .env  # then set SESSION_SECRET (openssl rand -hex 32) and APP_DOMAIN/APP_URI
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
| [`docs/roadmap.md`](docs/roadmap.md) | Done and remaining work |
| [`docs/design.md`](docs/design.md) | Product decisions and open questions |

Agent guidance (commands, gotchas, definition of done) is in [`AGENTS.md`](AGENTS.md).

## Status

Live on TestNet. Factory [`773811780`](https://lora.algokit.io/testnet/application/773811780/), ClaimsVault [`773811800`](https://lora.algokit.io/testnet/application/773811800/). Current work is tracked in [`docs/roadmap.md`](docs/roadmap.md).

## License

Demo project for educational purposes.
