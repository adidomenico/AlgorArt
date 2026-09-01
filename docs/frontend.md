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

## Current state

The Phase 2 frontend is implemented. The AlgoKit starter's `Home` hero and
"send 1 ALGO" demo (`Transact`) are replaced by the campaign feature set
below. The wallet plumbing (`WalletManager` + `WalletProvider` +
Pera/Defly/Exodus/KMD) is unchanged.

## Structure (implemented)

```text
projects/frontend/src/
├── features/
│   ├── campaigns/            # create, browse, details
│   │   ├── CampaignList.tsx        # browse all campaigns
│   │   ├── CampaignCard.tsx        # one card in the list
│   │   ├── CampaignDetail.tsx      # single campaign + claim/refund/pledge
│   │   ├── CreateCampaignForm.tsx  # create() ABI call
│   │   └── PledgeForm.tsx          # pledge() ABI call (payment + app call)
│   └── app/                  # shared app chrome
│       └── Nav.tsx                 # brand, wallet button, address badge
├── lib/                      # shared services
│   ├── algorand.ts           # lazy AlgorandClient + IndexerClient singletons
│   ├── campaign.ts           # indexer -> CampaignViewModel mapping
│   ├── transaction.ts        # create/pledge/claim/refund send helpers
│   └── format.ts             # microAlgo / deadline formatting
├── contracts/                # generated typed clients (gitignored)
│   └── CampaignClient.ts
├── components/               # generic UI (ConnectWallet, Account, ErrorBoundary)
├── Home.tsx                  # state-based navigation between list/detail/create
└── utils/                    # ellipseAddress, network config
```

## Pages & routing

No router dependency is required for Phase 2; a lightweight state-based
navigation (selected campaign id) is enough. Add `react-router` later if the
route structure grows.

| View | Content | Reads | Writes |
| --- | --- | --- | --- |
| **Browse** | Grid of campaign cards, filtered by status | indexer list | — |
| **Detail** | Full campaign state, progress bar, action buttons | indexer detail + boxes | claim / refund |
| **Create** | Title + metadata URI + goal (ALGO) + deadline form | — | `create()` |
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
  title: string
  metadataUri: string
  goalMicroAlgos: bigint
  raisedMicroAlgos: bigint
  deadline: Date
  status: CampaignStatus
  /** undefined when the connected wallet has not pledged */
  myPledgeMicroAlgos?: bigint
}
```

The derived `funded` state (deadline passed **and** `raised >= goal`) and the
derived `failed` state (deadline passed **and** `raised < goal`) are both
computed client-side from `goal`/`raised`/`deadline` — exactly the same rule
the contract evaluates. Neither is stored on-chain: `funded` is never
materialised, and `failed` only becomes a stored `status` after the first
`refund()` call. Deriving `failed` client-side is what lets a backer start the
first refund from the UI.

## Campaign metadata (implemented)

The contract stores a short `title` (on-chain) plus a `metadataUri` pointer to
off-chain JSON (ARC-3-style: description, image, category). The hybrid approach:

- **On-chain:** `title` (string) in global state, passed to `create()`.
  Cheap, readable straight from the indexer — no IPFS lookup needed for lists.
- **Off-chain:** `metadataUri` (string) in global state pointing to a JSON
  blob on IPFS with the long description, image, and category.

`title` is fixed at create. The frontend `CampaignViewModel` exposes both
`title` and `metadataUri`: browse cards render `title` directly; the detail view
shows the `metadataUri` (fetching and rendering the off-chain JSON remains a
Phase 4 nicety). `title` and `metadataUri` are ABI `byte[]` arguments to
`create`, encoded on-chain as `bytes`, each capped at 128 bytes (the AVM limit
for a bytes global-state value) — enforced both on-chain and in the create form.

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
  args: { title: new TextEncoder().encode(title), metadataUri: new TextEncoder().encode(metadataUri), goal: goalMicroAlgos, deadline: deadlineUnixSeconds },
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

## Refund UX & fee disclaimers (planned)

A failed campaign leaves funds at the escrow until backers reclaim them, and a
refund is itself a transaction that some account must sign and pay for. The
refund UX gives backers two paths — self-service for the individual, a batch
sweep for closure — and states the estimated network fee beside every action so
the cost is never a surprise.

### Backer banner

On a failed campaign, a connected backer with an outstanding pledge sees a
prominent banner in the detail view:

> **This campaign failed to reach its goal.** You're owed **X.XXXX ALGO**.
> **Refund my pledge** (network fee ≈ 0.002 ALGO)

The banner is derived from the derived `failed` status and
`myPledgeMicroAlgos`; no extra on-chain read is needed.

### Cancel pledge (while open)

A connected backer on a still-open campaign sees a **Cancel pledge** action next
to their pledge amount, with a fee disclaimer:

> **Cancel pledge** (network fee ≈ 0.002 ALGO)

Cancelling calls the proposed `cancelPledge()` method: it returns the pledge and
removes the backer's box, before the deadline. It is only shown while the
campaign status is `open` and `myPledgeMicroAlgos > 0`; after the deadline the
outcome is locked and only `claim`/`refund` apply.

### Refund all (batch sweep)

A failed campaign also exposes a **Refund all backers** action. It drives the
contract's `refundBatch` method in a loop: read the outstanding backer boxes
from the indexer, refund them in batches of up to 8, and repeat until the
escrow is drained. The action is available to anyone — creator, backers, or a
volunteer — because the sweep is permissionless (see the contract docs).

### Fee disclaimers

The estimated fees, shown beside the buttons:

| Action | Transactions | Estimated network fee |
| --- | --- | --- |
| `cancelPledge()` — one backer, before deadline | 1 app call + 1 inner payment | ≈ 0.002 ALGO |
| `refund()` — one backer | 1 app call + 1 inner payment | ≈ 0.002 ALGO |
| `refundBatch()` — up to 8 backers | 1 app call + 8 inner payments | ≈ 0.009 ALGO |

Each Algorand transaction fee is 1,000 µA (0.001 ALGO); the outer app call must
also cover one minimum fee per inner payment. Refund **amounts** are never
reduced by fees — the fee is paid by whoever signs the transaction (the backer
for an individual refund, the sweep caller for a batch).

This is the price of finality: the blockchain cannot make a refund "free", only
decide *whose* wallet pays it. The fee is fixed, tiny, and public — a fraction
of a cent to reclaim a pledge of any size.

## Edge cases & gotchas

The UI-level cases that matter once cancel/batch refunds land; the contract-level
ones live in `docs/contracts/campaign.md` → "Known edge cases".

- **Indexer lag.** After a write (create/pledge/claim/refund), the indexer may lag a
  round or two. The detail view's `load()` refetch can show stale data — prefer
  re-reading from algod or a short poll/refresh after a mutation.
- **Client clock drift.** The deadline is computed from `Date.now()/1000`. A skewed
  clock can produce a deadline in the past (contract rejects) or absurdly far out;
  clamp the duration to a sane range in the create form.
- **Bytes vs. characters.** `title`/`metadataUri` are capped at 128 **bytes**, not
  characters. The form already validates via `TextEncoder`, so emoji pass the UI
  `maxLength` but are rejected by byte count — keep the `TextEncoder` check.
- **Pledge > wallet balance.** Validate against the connected account's ALGO balance
  before opening the wallet; otherwise the wallet errors after the fact.
- **Approval race.** The user signs a pledge/cancel, but the deadline passes before
  submission — the transaction just fails; handle the failure message gracefully.
- **Wallet/network mismatch.** Wallet on TestNet while the app targets MainNet (or
  vice versa); check the wallet's active network against `VITE_ALGOD_NETWORK`.
- **Fractional ALGO rounding.** `parseAlgoToMicroAlgos` should reject or round
  sub-microAlgo inputs (6+ decimal places) predictably.
- **Batch sweep correctness.** "Refund all" must fetch live box addresses from the
  indexer, dedupe, and never pass an address twice — a bad entry reverts the whole
  `refundBatch` call.
- **Suppress pledge readout on `claimed`.** `claim()` leaves pledge boxes behind, so
  the detail view must not show "Your pledge: X ALGO" once the campaign is `claimed`.

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

The frontend has its own Vitest config (`vitest.config.ts`, jsdom environment)
plus `@testing-library/react`, `@testing-library/jest-dom`,
`@testing-library/user-event`, and `@vitest/coverage-v8`. Run with
`npm run test`; coverage via `npm run test:coverage`.

Coverage gates **components and utils** (the app shell `App`/`Home`/`main` and
the generated `src/contracts/**` clients are excluded), with thresholds of
90% across lines/branches/functions/statements:

- `lib/format.ts` — ALGO/microAlgo conversion, deadline/countdown formatting.
- `lib/campaign.ts` — global-state decoding, status derivation, pledge-box
  name/value encoding, and the indexer-backed read helpers.
- `lib/algorand.ts` / `lib/transaction.ts` — lazy client singletons and the
  create/pledge/claim/refund send helpers (mocked at the `CampaignClient` boundary).
- `features/campaigns/*` — `CampaignList`, `CampaignCard`, `CampaignDetail`,
  `CreateCampaignForm`, `PledgeForm`.
- `features/app/Nav`, `components/*` (ConnectWallet, Account, ErrorBoundary),
  and `utils/*`.

Component tests mock `@txnlab/use-wallet-react` (wallet context) and the
indexer/client services via `vi.mock`.

## Out of scope for Phase 2

- Campaign metadata — implemented (hybrid, see [Campaign metadata](#campaign-metadata-implemented)); rich media/IPFS rendering remains Phase 4.
- Cancel-before-deadline — Phase 4 (needs a contract change).
- TestNet deployment — Phase 3.
- Backend / database — never; the indexer is the read model.
