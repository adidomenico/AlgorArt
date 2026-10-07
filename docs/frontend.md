# Frontend design

How the AlgorArt dApp is planned and structured. The contract is the source of
truth; the frontend is a **read model + signer**: it reads campaign state from
the indexer, and it assembles + signs transaction groups for the user's wallet.
It never holds keys, never holds funds, and never decides a campaign outcome.

> Contract internals: [`campaign.md`](campaign.md) and
> [`claim-tree-protocol.md`](claim-tree-protocol.md). Factory & catalog:
> [`architecture.md`](architecture.md).

## Principles

1. **The contract is the source of truth.** Every decision (deadline passed?
   goal met? claimable? refundable?) is made on-chain. The frontend computes a
   *display* status from the same public state, but the contract's assertions
   are the final authority.
2. **Non-custodial.** The app only ever receives signed transactions. The
   wallet (Pera / Defly / LocalNet KMD) holds the keys.
3. **Reads go through the indexer, writes go through the generated clients.**
   One code path for data, one code path for transactions.
4. **Receipts are reconstructed, never trusted.** A backer's pledge is their
   leaf in the campaign's frontier-Merkle tree — the UI replays pledge/null
   events from the indexer into frontiers and paths (`lib/claimtree.ts`) and
   the contract authenticates every proof.

## Structure (implemented)

```text
projects/frontend/src/
├── features/
│   ├── campaigns/            # create, browse, details
│   │   ├── CampaignList.tsx        # browse all campaigns
│   │   ├── CampaignCard.tsx        # one card in the list
│   │   ├── CampaignDetail.tsx      # single campaign + per-leaf pledge/cancel/refund, claim/delete, window banner
│   │   ├── CreateCampaignForm.tsx  # create → register action
│   │   └── PledgeForm.tsx          # pledge() amount input (+ fee note)
│   └── app/                  # shared app chrome
│       └── Nav.tsx                 # brand, wallet button, address badge
├── lib/                      # shared services
│   ├── algorand.ts           # lazy AlgorandClient + IndexerClient singletons
│   ├── campaign.ts           # indexer -> CampaignViewModel mapping + Factory box search
│   ├── claimtree.ts          # proof builder: indexer event replay → frontiers/paths (see below)
│   ├── claimtree.vectors.ts  # committed oracle vectors (generated, do not edit)
│   ├── transaction.ts        # create/register/pledge/claim/refund/cancel/delete send helpers
│   └── format.ts             # microAlgo / deadline formatting
├── contracts/                # generated typed clients (gitignored)
│   ├── Campaign.ts
│   ├── ClaimsVault.ts
│   └── Factory.ts
├── components/               # generic UI (ConnectWallet, Account, ErrorBoundary)
├── Home.tsx                  # state-based navigation between list/detail/create
└── utils/                    # ellipseAddress, network config
```

## Pages & routing

No router dependency is required for the current scope; a lightweight state-based
navigation (selected campaign id) is enough.

| View | Content | Reads | Writes |
| --- | --- | --- | --- |
| **Browse** | Grid of campaign cards, Factory-registered only | indexer list + Factory box search | — |
| **Detail** | Full campaign state, progress bar, per-pledge actions | indexer detail + live leaves + vault box | pledge / claim / refund / cancelPledge / delete |
| **Create** | Title + metadata URI + goal (ALGO) + deadline form | — | `create()` + `factory.register()` |
| **Pledge** | Amount input on the detail page | tree replay (frontier) | payment + `pledge()` + `credit()` (one atomic group) |

## Data model

The indexer exposes each campaign as an `Application` (`id` + `params`). The
contract's global state arrives as `params.global-state`: a list of
`{ key, value }` pairs where each key is the base64 of the UTF-8 key name
(`creator`, `title`, `metadataUri`, `goal`, `deadline`, `raised`, `status`,
`root`, `n`). A backer's pledge is **their live leaves** — `fetchMyLeaves`
replays their pledge positions and drops the spent ones; the pledge total is
the live sum.

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
  deadlineSeconds: bigint
  status: CampaignStatus
  myPledgeMicroAlgos?: bigint          // live-leaf sum for the viewer
}
```

The derived `funded`/`failed` states are computed client-side from
`goal`/`raised`/`deadline` — exactly the rule the contract evaluates. Neither is
stored on-chain; `failed` only materialises in `status` after the first
`refund()`.

## Campaign metadata

The contract stores a short `title` on-chain plus a `metadataUri` pointer to
off-chain JSON (see [`campaign.md`](campaign.md)). The 128-byte cap on both
fields is enforced on-chain and re-checked in the create form.

The JSON follows an ARC-3-style shape (`{name, description, image, category}`,
all optional; `lib/metadata.ts`). `ipfs://` URIs resolve through the public
`https://green-cooperative-koi-991.mypinata.cloud/ipfs/` gateway (demo Pinata gateway:
the public gateway does not serve all pins since the Shipyard-maintained
`ipfs.io` gateway wound down in September 2026; a dedicated gateway belongs
here once the catalog backend exists).
`https://` URLs pass through. `CampaignImage` (`features/campaigns/`) renders the blob's `image` (or the URI itself when it
points straight at an image file) in the card and detail views, hiding itself
on any failure; the detail view also shows `description` and `category`. A blob
with none of the four fields is treated as absent, so seed/legacy URIs render
nothing instead of erroring. Upload/pinning is out of scope — creators paste a
URI today; server-side pinning rides with the catalog backend. Descriptions
evolve through the creator updates feed (roadmap), not by editing the blob —
the pledge-time content stays frozen and always viewable.

## Reads (indexer)

All reads use `algosdk.Indexer` configured from the same env as algod:

- **List campaigns** — with a Factory configured, read its registration boxes
  (`indexer.searchForApplicationBoxes(factoryId)`; one box search, decoded
  `'r' + appId` names) and look each id up directly. The unfiltered
  `searchForApplications` scan (key-presence discriminator) only runs when
  `VITE_FACTORY_APP_ID` is unset (dev mode): it never finishes on
  TestNet-scale chains, where every response carries thousands of unrelated
  apps with full approval programs.
- **One campaign** — `indexer.lookupApplications(appId).do()` for the global
  state.
- **My pledges** — `fetchMyLeaves`: replay the campaign's pledge calls (with
  group payments paired by block position) and vault/campaign spends, keep the
  viewer's unspent positions with amounts and payment TxIDs for proofs.
- **Vault box / window** — fresh reads (algod, not the indexer) drive refund
  routing (campaign vs vault path) and the refund-window banner.

## Writes (generated clients)

All writes go through the generated `CampaignClient` / `ClaimsVaultClient` /
`FactoryClient` (built from the ARC-56 specs by `algokit project link` — never
edited by hand). Pledges pay the **vault** (its app address, derived from
`VITE_VAULT_APP_ID` via `algosdk.getApplicationAddress`), never the campaign
escrow.

### create — create + register

```ts
const { result } = await new CampaignFactory({ algorand, defaultSender, defaultSigner }).send.create.create({
  args: { vault: vaultAppId(), title, metadataUri, goal, deadline },
  appReferences: [vaultAppId()],
})

// factory.register(): official-campaign proof; ~0.019 ALGO refundable deposit.
await factoryClient.send.register({ args: { app: appId, payment }, appReferences: [appId] })
```

No funding step exists — the v2 escrow never holds funds.

### pledge — one atomic group with a fresh frontier

```ts
// The wallet signer is registered for composer resolution, then:
const tree = await loadTree(appId, vaultAppId(), vaultAddress())
const composer = algorand.send.newGroup()
composer.addAppCallMethodCall(await campaignClient.params.pledge({
  args: { payment, frontier: frontierForPledge(tree) },  // backer -> VAULT, the pledge amount
  sender,
}))
composer.addAppCallMethodCall(await vaultClient.params.credit({
  args: { app: appId, amount },
  sender,
  appReferences: [factoryAppId()],                       // inner isRegistered target
  boxReferences: [vaultCampaignBox, factoryRegistrationBox],
  extraFee: microAlgos(1000),                            // first-touch factory check
}))
await composer.send()
```

The frontier is rebuilt from the indexer right before submitting; on a
`stale or forged frontier` rejection the helper rebuilds once and retries.
The payment TxID must be read from the confirmed group (it commits to the
group assignment) — never precomputed.

### claim — the vault pays the derived live total

```ts
await client.send.claim({
  args: [],
  appReferences: [vaultAppId()],          // inner call target
  boxReferences: [vaultCampaignBox],      // the one 65-byte campaign box
  extraFee: microAlgos(2000),             // inner app call + inner payment
})
```

### refund / cancelPledge — one leaf per call, routed by the vault box

Each spend carries a freshly rebuilt path for one position. Routing reads the
vault box fresh from algod: an `Open`/missing box goes through the campaign,
a `Failed` box goes straight to `vault.refund` (covers post-settle and
post-delete with the same proofs):

```ts
await client.send.refund({
  args: { k: position, amount, txid, path },
  appReferences: [vaultAppId()],
  boxReferences: [vaultCampaignBox],
  extraFee: microAlgos(3000),             // 1 OpUp iteration + inner payBack
})
// …or vaultClient.send.refund({
//   args: { app: appId, k: position, amount, txid, path },
//   boxReferences: [vaultCampaignBox],
//   extraFee: microAlgos(3000),
// })
```

A `proof does not match root` rejection rebuilds once and retries (a
concurrent spend moved the root).

### deleteCampaign — settle + close + unregister, one O(1) call

```ts
await client.send.delete.delete({
  args: [],
  appReferences: [vaultAppId()],
  boxReferences: [vaultCampaignBox],     // always declared; settle no-ops without one
  extraFee: microAlgos(2000),            // inner settle/notify + escrow close
})
await factoryClient.send.unregister({ args: { app: appId }, appReferences: [appId], extraFee: microAlgos(1000) })
```

### Fees

Each inner transaction (inner app call, inner payment, inner asset transfer) is
funded by fee pooling: the outer app call carries one extra minimum fee
(1,000 µA) per inner transaction via `extraFee`. Amounts are never reduced by
fees.

> Do **not** use `coverAppCallInnerTransactionFees: true` on the generated client
> send path — it requires a per-transaction `maxFee` + `additionalAtcContext` that
> the typed client doesn't populate. `extraFee` is the supported path (it is what
> the contract integration tests use).

## Refund UX & fee disclaimers

A failed campaign keeps the backers' funds at the vault until they reclaim them
(one leaf per call), and every spend is itself a transaction the backer signs
and pays for. The detail page states the estimated network fee beside every
money-moving action, and shows the refund-window banner (window end + sweep
target) once settled:

| Action | Transactions | Estimated network fee |
| --- | --- | --- |
| `pledge()` | 1 payment + 2 app calls | ≈ 0.004 ALGO |
| `refund()` / `cancelPledge()` | 1 app call + 1 OpUp iteration + 1 inner app call + 1 inner payment | ≈ 0.004 ALGO |
| `refund()` via the vault (post-settle) | 1 app call + 1 OpUp iteration + 1 inner payment | ≈ 0.004 ALGO |
| `claim()` | 1 app call + 1 inner app call + 1 inner payment | ≈ 0.003 ALGO |
| `delete()` (+ `unregister()`) | 1 app call + 2 inner txns (+ 1 unregister call) | ≈ 0.003 + 0.002 ALGO |

## Edge cases & gotchas

- **Indexer lag.** After a write (create/pledge/claim/refund), the indexer may lag a
  round or two; the helpers wait on the confirmation round where available.
- **Client clock drift.** The deadline is computed from `Date.now()/1000`; clamp
  the duration to a sane range in the create form.
- **Bytes vs. characters.** `title`/`metadataUri` are capped at 128 **bytes**;
  keep the `TextEncoder` check.
- **Pledge > wallet balance.** Validate against the connected account's ALGO balance
  before opening the wallet.
- **Approval race.** The user signs a pledge/cancel, but the deadline passes before
  submission — the transaction fails; handle the message gracefully.
- **Proof race.** A concurrent pledge/refund can move the tree root between the
  UI's read and its submit — the helpers rebuild proofs once and retry; only a
  second failure surfaces, with a retry hint.
- **Close-out needs the exact `closeRemainderTo` parameter** (the escrow close
  is a payment with `closeRemainderTo`, set by the contract, not the UI).
- **The Factory and the vault must be funded.** `register()` needs the Factory's
  app account to hold the registration deposits; the vault's app account holds
  the pooled pledges plus its parked per-campaign MBR (32,100 µA per box). The
  deploy scripts fund both once.
- **`VITE_FACTORY_APP_ID` / `VITE_VAULT_APP_ID`.** The browse filter and every
  pledge/refund depend on these env vars matching the deployed apps; an empty
  Factory id disables the official-campaign filter.
- **Inner vault calls need box references.** `claim()`, `refund()`,
  `cancelPledge()`, and `delete()` inner-call the vault, whose box read/write
  requires the campaign box (`'c' + appId`) declared on the outer transaction
  — the AVM rejects undeclared box access. First-touch `credit` additionally
  declares the Factory app and its registration box.
- **The vault address is the pledge receiver.** `pledge()` rejects payments
  sent anywhere else, so the helper derives the address from
  `algosdk.getApplicationAddress(VITE_VAULT_APP_ID)`.
- **The composer does not dedupe.** Pass each transaction either explicitly
  (`addTransaction`) or by method-arg reference, never both — otherwise the
  group carries it twice.
- **Suppress pledge readout on `claimed`.** Spent leaves drop out of the live
  set, so the detail view's "Your pledge" reflects the live total naturally.

## Wallet integration

Already present and unchanged: `App.tsx` builds a `WalletManager`
(`@txnlab/use-wallet-react`) with Pera + Defly + Exodus (mainnet/testnet) or KMD
(localnet, driven by `VITE_ALGOD_NETWORK === 'localnet'`). Components consume
`useWallet()` for `activeAddress`, `transactionSigner`, and `wallets`.

## Formatting & units

- **Amounts** are always microAlgos on-chain (`bigint`). Display as ALGO with
  `algo()` / `microAlgos()` from `@algorandfoundation/algokit-utils`.
- **Deadline** is a UNIX timestamp in seconds; the UI renders a local date and a
  countdown.
- **Pledge positions** are 0-based leaf indices, stable forever (positions are
  never reused); the detail view labels them "Pledge #k".

## Styling (Tailwind CSS v4)

All styling is Tailwind utilities. The palette lives as `@theme` tokens in
`projects/frontend/src/styles/App.css` (`bg-teal`, `text-ink`, `border-line`,
`bg-badge-open`, …) — no BEM classes, no separate stylesheet per component.
Status badges map via a `badgeBg` record so class names stay static for the
Tailwind scanner (never `bg-badge-${status}`).

## Testing (Vitest)

The frontend has its own Vitest config (jsdom environment) plus
`@testing-library/react` and `@vitest/coverage-v8`. Run with `npm run test`;
coverage via `npm run test:coverage`.

Coverage gates **components and utils** (the app shell and generated clients are
excluded), with thresholds of 90% across lines/branches/functions/statements:

- `lib/format.ts` — ALGO/microAlgo conversion, deadline/countdown formatting.
- `lib/campaign.ts` — global-state decoding, status derivation, tree-sum pledge
  reads, Factory box decoding, and the indexer-backed read helpers.
- `lib/claimtree.ts` — the proof builder (tree math + indexer replay), proven
  against committed oracle vectors (`claimtree.vectors.ts`, regenerated by
  `scripts/generate-claimtree-vectors.py`).
- `lib/algorand.ts` / `lib/transaction.ts` — client singletons and the
  create/register/pledge/claim/refund/cancel/delete helpers (mocked at the
  client/composer boundary, proof builder mocked for flow tests).
- `features/campaigns/*` and the rest of `features/app/Nav`, `components/*`,
  `utils/*`.

Component tests mock `@txnlab/use-wallet-react` (wallet context) and the
indexer/client services via `vi.mock`.

## Out of scope for now

- Campaign metadata — implemented (hybrid, see [Campaign metadata](#campaign-metadata)); rich media/IPFS rendering is on the roadmap.
- TestNet deployment — on the roadmap.
- Backend / database — optional catalog only; the indexer + Factory are the read model.
