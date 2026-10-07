# AlgorArt

A **non-custodial crowdfunding dApp** on **Algorand** for funding creative
projects — books, music, movies, art.

Creators open a campaign with a funding goal and a deadline. Backers pledge
real **ALGO** from their own wallets. A smart contract — not a server — holds
the funds and enforces the rules: goal met by the deadline, the creator
claims; otherwise every backer reclaims their pledge.

Crowdfunding is a trust problem, and a blockchain solves it without a
middleman: funds lock in a contract instead of the creator's pocket, the
*raise X by date Y or refund everyone* rule is enforced by the network, and
every pledge, total, and deadline is public on-chain state. Algorand fits
because it is fast (~4 second finality) with tiny fees (~0.001 ALGO).

Non-custodial means you connect **Pera / Defly / Exodus** and keep your keys
(the app only ever sees signed transactions), while the **Algorand chain** is
the source of truth.

Technical details live in [`docs/`](docs/):

- [campaign](docs/campaign.md) and [claim-tree
  protocol](docs/claim-tree-protocol.md) — contract internals
- [architecture](docs/architecture.md) — Factory, vault, tech stack, layout
- [frontend](docs/frontend.md) — UI structure, wallet, metadata, testing
- [testing](docs/testing.md) — contract and frontend test strategy
- [CI](docs/ci.md) — workflows and checks
- [roadmap](docs/roadmap.md) — what is left to do
- [product design](docs/design.md) — design decisions and open questions

## Status

Live on TestNet since October 2026 — Factory `773811780`, ClaimsVault
`773811800` ([roadmap](docs/roadmap.md) records the deploy). Current work
follows the roadmap checklist.

## Getting started

### Prerequisites

- **Node.js LTS** (v20+ for the frontend, v22+ for contracts)
- **Docker** — only for the LocalNet sandbox (algod + indexer)
- **AlgoKit CLI** — compiles contracts, deploys, and manages the local sandbox

### Run it locally

```bash
algokit project bootstrap all    # install deps for contracts/ + frontend/
algokit localnet start           # start algod + indexer in Docker (the "chain")
algokit project run build        # compile contracts + generate typed clients

cd projects/contracts
npm run deploy:ci -- factory     # deploy the Factory (prints the app id)
FACTORY_APP_ID=<factory id> npm run deploy:ci -- claimsvault  # deploy the ClaimsVault
FACTORY_APP_ID=<factory id> VAULT_APP_ID=<vault id> npm run seed  # demo data
npm run unseed                    # remove seeded campaigns (same env vars)

cd ../frontend
# set VITE_FACTORY_APP_ID=<factory id> and VITE_VAULT_APP_ID=<vault id> in .env
npm run dev                      # frontend on http://localhost:5173
npm run reclaim                  # reclaim demo funds + unregister (needs *_MNEMONIC env vars)

algokit project run lint         # ESLint across all projects
algokit project run format       # Prettier check across all projects
algokit project run check-types  # type-check across all projects
algokit project run test         # contract unit tests (offline AVM, via Vitest)

npx --yes markdownlint-cli2@0.23.2        # markdownlint across all docs (add --fix to autofix)
```

## License

Demo project for educational purposes.
