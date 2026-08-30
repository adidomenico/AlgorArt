# Frontend design (Phase 2)

How the AlgorArt dApp is planned and structured. The contract is the source of
truth; the frontend is a **read model + signer**: it reads campaign state from
the indexer, and it assembles + signs transaction groups for the user's wallet.
It never holds keys, never holds funds, and never decides a campaign outcome.

> Contract internals: [`contracts/campaign.md`](contracts/campaign.md).
> The on-chain rules enforced by the contract are **not** re-implemented in the
> frontend — the UI only *surfaces* state and *triggers* signed transactions.

## Principles

1. **The contract is the source of truth.** Every decision (deadline passed?
   goal met? claimable? refundable?) is made on-chain. The frontend computes a
   *display* status from the same public state, but the contract's assertions
   are the final authority.
2. **Non-custodial.** The app only ever receives signed transactions. The
   wallet (Pera / Defly / LocalNet KMD) holds the keys.
3. **Reads go through the indexer, writes go through the generated client.**
   One code path for data, one code path for transactions.
4. **Feature folders, thin components.** The AlgoKit starter's
   `Home.tsx`/`Transact.tsx` demo is replaced by a feature-based layout.

## Current state (baseline)

The frontend is still the **AlgoKit React starter**: a `Home` hero with a
wallet-connect modal (`ConnectWallet`) and a generic "send 1 ALGO" demo
(`Transact`). The wallet plumbing (`WalletManager` + `WalletProvider` +
Pera/Defly/Exodus/KMD) already works — that part is done and stays. What's
missing is everything campaign-specific.

## Target structure

```text
projects/frontend/src/
├── features/
│   ├── campaigns/            # create, browse, details
│   │   ├── CampaignList.tsx        # browse all campaigns
│   │   ├── CampaignCard.tsx        # one card in the list
│   │   ├── CampaignDetail.tsx      # single campaign + actions
│   │   ├── CreateCampaignForm.tsx  # create() ABI call
│   │   ├── PledgeForm.tsx          # pledge() ABI call (payment + app call)
│   │   └── campaigns.utils.ts      # status/deadline/format helpers (pure)
│   ├── wallet/               # connect button + provider (already exists)
│   │   ├── ConnectWallet.tsx
│   │   └── Account.tsx
│   └── app/                  # shared app chrome
│       └── Nav.tsx                 # brand, wallet button, network badge
├── lib/                      # shared services (new)
│   ├── algorand.ts           # AlgorandClient + IndexerClient singletons
│   ├── campaign.ts           # indexer -> CampaignViewModel mapping
│   ├── transaction.ts        # create/pledge/claim/refund send helpers
│   └── format.ts             # microAlgo / deadline formatting
├── contracts/                # generated typed clients (gitignored)
│   └── CampaignClient.ts
├── components/               # generic UI (ErrorBoundary stays)
└── utils/                    # ellipseAddress, network config (keep)
```

## Pages & routing

No router dependency is required for Phase 2; a lightweight state-based
navigation (selected campaign id) is enough. Add `react-router` later if the
route structure grows.

| View | Content | Reads | Writes |
| --- | --- | --- | --- |
| **Browse** | Grid of campaign cards, filtered by status | indexer list | — |
| **Detail** | Full campaign state, progress bar, action buttons | indexer detail + boxes | claim / refund |
| **Create** | Goal (ALGO) + deadline form | — | `create()` |
| **Pledge** | Amount input on the detail page | — | `pledge()` |

## Data model

The indexer exposes each campaign as an `Application` (`id` + `params`). The
contract's global state arrives as `params.global-state`: a list of
`{ key, value }` pairs where each key is the base64 of the UTF-8 key name
(`creator`, `goal`, `deadline`, `raised`, `status`). A backer's pledge amount
lives in a box, fetched separately (see [reads](#reads-indexer)).

```ts
// lib/campaign.ts — the shape the UI renders
type CampaignStatus = 'open' | 'funded' | 'failed' | 'claimed'

interface CampaignViewModel {
  id: bigint
  creator: string
  goalMicroAlgos: bigint
  raisedMicroAlgos: bigint
  deadline: Date
  status: CampaignStatus
  /** undefined when the connected wallet has not pledged */
  myPledgeMicroAlgos?: bigint
}
```

The derived `funded` state (deadline passed **and** `raised >= goal`) is
computed client-side from `goal`/`raised`/`deadline` — exactly the same rule
the contract evaluates. It is never stored on-chain.

## Reads (indexer)

All reads use `algosdk.Indexer` configured from the same env as algod:

```ts
import algosdk from 'algosdk'
const indexer = new algosdk.Indexer(token, server, port)
```

- **List campaigns** — `indexer.searchForApplications().do()`, then filter to
  apps whose `global-state` contains the `Campaign` keys. (There is no app-name
  filter, so the filter is by the presence of the known global-state keys.)
- **One campaign** — `indexer.lookupApplications(appId).do()` for the global
  state, plus `indexer.searchForApplicationBoxes(appId).do()` for backer boxes.
- **My pledge** — decode the box named by the `p` prefix + the connected
  address; absent box means no pledge yet.

Global-state keys decode as: `creator` (bytes → address),
`goal`/`deadline`/`raised`/`status` (uint). The contract's `status` mapping is
`0` Open, `1` Failed, `2` Claimed.

## Writes (generated client)

All writes go through the generated `CampaignClient` (built from
`Campaign.arc56.json` by `algokit project link` — never edited by hand). The
client is constructed once per app id with the wallet's signer wired to the
active address:

```ts
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { CampaignClient } from '../contracts/CampaignClient'

const algorand = AlgorandClient.fromClients({ algod })   // from lib/algorand.ts
const client = new CampaignClient({ algorand, appId, defaultSender: activeAddress, defaultSigner: transactionSigner })
```

### create — deploy a campaign

```ts
const factory = new CampaignFactory({ algorand, defaultSender: activeAddress, defaultSigner: transactionSigner })
const { appClient, result } = await factory.send.create.create({
  args: { goal: goalMicroAlgos, deadline: deadlineUnixSeconds },
})
// result.appId / result.appAddress identify the new campaign
```

### pledge — payment + app call in one atomic group

`pledge` takes an ABI `pay` argument, so the payment must be added to the same
transaction group as the app call:

```ts
await client.send.pledge({
  args: {
    payment: await algorand.createTransaction.payment({
      sender: activeAddress,
      receiver: client.appAddress,       // the escrow
      amount: microAlgos(pledgeAmount),
    }),
  },
})
```

The client adds the payment transaction to the group, assigns it as the ABI
`pay` argument, and the wallet signs the whole group. The contract then checks
`sender == caller`, `receiver == escrow`, and `amount > 0`.

### claim / refund — bare no-arg calls

```ts
await client.send.claim()
await client.send.refund()
```

Both issue inner payments (to the creator / the backer), so the app call fee
must cover the inner transaction: pass `coverAppCallInnerTransactionFees: true`
(or add `extraFee`) in the send params.

## Wallet integration

Already present and unchanged: `App.tsx` builds a `WalletManager`
(`@txnlab/use-wallet-react`) with Pera + Defly + Exodus (mainnet/testnet) or KMD
(localnet, driven by `VITE_ALGOD_NETWORK === 'localnet'`). Components consume
`useWallet()` for `activeAddress`, `transactionSigner`, and `wallets`.

## Formatting & units

- **Amounts** are always microAlgos on-chain (`bigint`). Display as ALGO with
  `algo()` / `microAlgos()` from `@algorandfoundation/algokit-utils`.
- **Deadline** is a UNIX timestamp in seconds (the contract's
  `Global.latestTimestamp`); the UI renders a local date and a countdown.

## Testing (Vitest)

Phase 2 adds the frontend to the `unit-test` matrix with line coverage ≥ 90%
on components and utils. Pure helpers first (easiest to cover, most valuable):

- `lib/format.ts` — ALGO/microAlgo conversion, deadline/countdown formatting.
- `lib/campaign.ts` — global-state decoding and status derivation.
- `features/campaigns/campaigns.utils.ts` — status/deadline helpers.

Component tests (React Testing Library) mock the wallet context and the
indexer/client services. The existing `vitest.config.mts` /
`vitest.setup.ts` live in the **contracts** project; the frontend needs its own
Vitest config plus `@testing-library/react` and `@vitest/coverage-v8` added to
`package.json` (and a `test` script — currently absent, see
[`ci.md`](ci.md)).

## Out of scope for Phase 2

- Campaign images/metadata (IPFS) — Phase 4.
- Cancel-before-deadline — Phase 4 (needs a contract change).
- TestNet deployment — Phase 3.
- Backend / database — never; the indexer is the read model.
