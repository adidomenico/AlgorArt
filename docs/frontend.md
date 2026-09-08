# Frontend design

How the AlgorArt dApp is planned and structured. The contract is the source of
truth; the frontend is a **read model + signer**: it reads campaign state from
the indexer, and it assembles + signs transaction groups for the user's wallet.
It never holds keys, never holds funds, and never decides a campaign outcome.

> Contract internals: [`campaign.md`](campaign.md).
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

The core frontend is implemented. The AlgoKit starter's `Home` hero and
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
│   ├── campaign.ts           # indexer -> CampaignViewModel mapping + leaf reconstruction
│   ├── merkle.ts             # fanout-8 tree math (leafHash, proofs, verify)
│   ├── transaction.ts        # create/fund/pledge/claim/refund/cancelPledge send helpers
│   └── format.ts             # microAlgo / deadline formatting
├── contracts/                # generated typed clients (gitignored)
│   └── CampaignClient.ts
├── components/               # generic UI (ConnectWallet, Account, ErrorBoundary)
├── Home.tsx                  # state-based navigation between list/detail/create
└── utils/                    # ellipseAddress, network config
```

## Pages & routing

No router dependency is required for the current scope; a lightweight state-based
navigation (selected campaign id) is enough. Add `react-router` later if the
route structure grows.

| View | Content | Reads | Writes |
| --- | --- | --- | --- |
| **Browse** | Grid of campaign cards, filtered by status | indexer list | — |
| **Detail** | Full campaign state, progress bar, action buttons | indexer detail + boxes | claim / refund / cancelPledge |
| **Create** | Title + metadata URI + goal (ALGO) + deadline form | — | `create()` |
| **Pledge** | Amount input on the detail page | — | `pledge()` |

## Data model

The indexer exposes each campaign as an `Application` (`id` + `params`). The
contract's global state arrives as `params.global-state`: a list of
`{ key, value }` pairs where each key is the base64 of the UTF-8 key name
(`creator`, `goal`, `deadline`, `raised`, `status`, `leafCount`). A backer's
pledge amount is not stored per-backer on-chain — it is reconstructed from the
pledge leaves of the Merkle tree (see [reads](#reads-indexer)).

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

## Campaign metadata

The contract stores a short `title` on-chain plus a `metadataUri` pointer to
off-chain JSON (see [`campaign.md`](campaign.md) for the contract-side rules).

The frontend `CampaignViewModel` exposes both: browse cards render `title`
directly; the detail view shows the `metadataUri` (fetching and rendering the
off-chain JSON remains a later nicety). The 128-byte cap on both fields is
enforced on-chain and re-checked in the create form.

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
  state.
- **Pledge leaves** — reconstructed from `searchForTransactions`: the pledge
  `appl` calls to the campaign (filtered by sender != creator and matched to the
  payment in their group) yield the ordered leaf list `(address, amount)`.
- **Spent bitmap** — read the `spent` shard boxes (key `'s'` + shard index) to
  tell which leaves are already spent.
- **My pledge** — the sum of the connected backer's live (not-yet-spent) leaves;
  no live leaves means no pledge yet.

Global-state keys decode as: `creator` (bytes → address),
`goal`/`deadline`/`raised`/`status`/`leafCount` (uint). The contract's `status`
mapping is `0` Open, `1` Failed, `2` Claimed.

The tree math lives in `lib/merkle.ts` (a port of the contract's
`sha256` fanout-8 tree): `leafHash`, `siblingsFor`, `proofBytes`, and `verify`
produce the `(proof, index, amount)` a backer submits to `refund`/`cancelPledge`.
The frontend is the "survivable" fallback of the backend proof endpoint — it
rebuilds the whole tree from the indexer when a proof is needed.

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

### create — deploy a campaign and fund its storage deposit

```ts
const factory = new CampaignFactory({ algorand, defaultSender: activeAddress, defaultSigner: transactionSigner })
const { appClient, result } = await factory.send.create.create({
  args: { title: new TextEncoder().encode(title), metadataUri: new TextEncoder().encode(metadataUri), goal: goalMicroAlgos, deadline: deadlineUnixSeconds },
})
// result.appId / result.appAddress identify the new campaign
```

`create()` is followed by a separate `fund()` call: the creator pays the escrow's
storage deposit so the first pledge can create the frontier box (see
[`campaign.md`](campaign.md) → "The storage deposit"). The frontend funds the
recommended worst-case deposit (≈ 2.30 ALGO) in the same `createCampaign`
helper, so the two steps are one user action.

```ts
await client.send.fund({
  args: {
    payment: await algorand.createTransaction.payment({
      sender: activeAddress,
      receiver: client.appAddress,       // the escrow
      amount: microAlgos(deposit),
    }),
  },
})
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

### claim — bare no-arg call

```ts
await client.send.claim({ args: [], extraFee: microAlgos(1000) })
```

### refund / cancelPledge — Merkle-proof calls

`refund` and `cancelPledge` take `(proof, index, amount)`. The frontend
reconstructs the campaign's pledge leaves from the indexer, picks the caller's
live leaves, and generates a proof for each one with `lib/merkle.ts`:

```ts
const { leaves, live } = await fetchPledgesForBacker(appId, address)   // lib/campaign.ts
const leafHashes = await Promise.all(leaves.map((l) => leafHash(decodeAddress(l.address).publicKey, l.amount)))
for (const leaf of live) {
  const proof = await proofBytes(leafHashes, leaf.index)
  await client.send.refund({ args: { proof, index: leaf.index, amount: leaf.amount }, extraFee: microAlgos(1000) })
  // …or client.send.cancelPledge({ args: { proof, index, amount }, extraFee: microAlgos(1000) })
}
```

A backer with several live leaves (re-pledges) gets one call per leaf.

Each issues an inner payment (to the creator / the backer / the backer), and the
contract hard-codes the inner payment's own fee to `0` (see the compiled TEAL:
`itxn_field Fee` → `0`). The caller therefore funds the inner transaction by fee
pooling: the outer app call must carry one extra minimum fee (1,000 µA) per inner
payment, which `extraFee: microAlgos(1000)` adds to the app call.

> Do **not** use `coverAppCallInnerTransactionFees: true` on the generated client
> send path — it requires a per-transaction `maxFee` + `additionalAtcContext` that
> the typed client doesn't populate, so it throws `Please provide a maxFee for
> each app call transaction...` at send time. `extraFee` is the supported path
> (it is what the contract integration tests use).

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

Cancelling calls `cancelPledge()`: it returns the pledge and removes the backer's
box, before the deadline. It is only shown while the campaign status is `open`
and `myPledgeMicroAlgos > 0`; after the deadline the outcome is locked and only
`claim`/`refund` apply.

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
ones live in [`campaign.md`](campaign.md) → "Known edge cases".

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
- **Batch sweep correctness.** "Refund all" must fetch live leaves from the
  indexer, dedupe, and never refund a spent leaf — a bad proof reverts the whole
  call.
- **Suppress pledge readout on `claimed`.** `claim()` leaves the leaves in place,
  so the detail view must not show "Your pledge: X ALGO" once the campaign is
  `claimed`.

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
- `lib/campaign.ts` — global-state decoding, status derivation, leaf/spent-bitmap
  reconstruction, and the indexer-backed read helpers.
- `lib/merkle.ts` — the fanout-8 tree math, checked against the contract's
  empty-subtree constants and proof round-trips.
- `lib/algorand.ts` / `lib/transaction.ts` — lazy client singletons and the
  create/fund/pledge/claim/refund/cancelPledge send helpers (mocked at the
  `CampaignClient` boundary).
- `features/campaigns/*` — `CampaignList`, `CampaignCard`, `CampaignDetail`,
  `CreateCampaignForm`, `PledgeForm`.
- `features/app/Nav`, `components/*` (ConnectWallet, Account, ErrorBoundary),
  and `utils/*`.

Component tests mock `@txnlab/use-wallet-react` (wallet context) and the
indexer/client services via `vi.mock`.

## Out of scope for now

- Campaign metadata — implemented (hybrid, see [Campaign metadata](#campaign-metadata)); rich media/IPFS rendering is on the roadmap.
- TestNet deployment — on the roadmap.
- Backend / database — never; the indexer is the read model.
