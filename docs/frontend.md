# Frontend design

How the AlgorArt dApp is planned and structured. The contract is the source of
truth; the frontend is a **read model + signer**: it reads campaign state from
the indexer, and it assembles + signs transaction groups for the user's wallet.
It never holds keys, never holds funds, and never decides a campaign outcome.

> Contract internals: [`campaign.md`](campaign.md) and
> [`claim-asa-redesign.md`](claim-asa-redesign.md). Factory & catalog:
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
4. **The Claim ASA is the pledge ledger.** A backer's pledge is their asset
   balance — no tree reconstruction, no proofs.

## Structure (implemented)

```text
projects/frontend/src/
├── features/
│   ├── campaigns/            # create, browse, details
│   │   ├── CampaignList.tsx        # browse all campaigns
│   │   ├── CampaignCard.tsx        # one card in the list
│   │   ├── CampaignDetail.tsx      # single campaign + pledge/claim/refund/cancel/closeOut/delete
│   │   ├── CreateCampaignForm.tsx  # create → fund → register → issueClaimAsa → attachClaimAsa → seedSupply action
│   │   └── PledgeForm.tsx          # pledge() ABI call (opt-in + payment to the vault + app call)
│   └── app/                  # shared app chrome
│       └── Nav.tsx                 # brand, wallet button, address badge
├── lib/                      # shared services
│   ├── algorand.ts           # lazy AlgorandClient + IndexerClient singletons
│   ├── campaign.ts           # indexer -> CampaignViewModel mapping + Claim ASA reads + Factory box search
│   ├── transaction.ts        # create/fund/register/issue/attach/seed/pledge/claim/refund/cancel/closeOut/delete send helpers
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
| **Detail** | Full campaign state, progress bar, action buttons | indexer detail + Claim ASA balance | pledge / claim / refund / cancelPledge / closeOut / delete |
| **Create** | Title + metadata URI + goal (ALGO) + deadline form | — | `create()` + `fund()` + `factory.register()` |
| **Pledge** | Amount input on the detail page | — | opt-in (if needed) + `pledge()` |

## Data model

The indexer exposes each campaign as an `Application` (`id` + `params`). The
contract's global state arrives as `params.global-state`: a list of
`{ key, value }` pairs where each key is the base64 of the UTF-8 key name
(`creator`, `title`, `metadataUri`, `goal`, `deadline`, `raised`, `status`,
`claimAsa`). A backer's pledge is **their Claim ASA balance** — one indexer
lookup, no history reconstruction.

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
  claimAsaId?: bigint          // set once fund() issued the Claim ASA
  myPledgeMicroAlgos?: bigint  // the viewer's claim-unit balance
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

## Reads (indexer)

All reads use `algosdk.Indexer` configured from the same env as algod:

- **List campaigns** — `indexer.searchForApplications().do()`, filtered to apps
  whose global state has the `Campaign` keys **and** whose app id appears in the
  Factory's registration boxes (`indexer.searchForApplicationBoxes(factoryId)`;
  one box search, decoded `'r' + appId` names). When `VITE_FACTORY_APP_ID` is
  unset, the registration filter is skipped (dev mode).
- **One campaign** — `indexer.lookupApplications(appId).do()` for the global
  state.
- **The Claim ASA id** — `claimAsa` in the campaign's global state.
- **My pledge** — `indexer.lookupAccountAssets(address).assetId(claimAsa)`:
  the balance is the pledge (1 unit = 1 µA); a 404 means not opted in yet.

## Writes (generated clients)

All writes go through the generated `CampaignClient` / `ClaimsVaultClient` /
`FactoryClient` (built from the ARC-56 specs by `algokit project link` — never
edited by hand). Pledges pay the **vault** (its app address, derived from
`VITE_VAULT_APP_ID` via `algosdk.getApplicationAddress`), never the campaign
escrow.

### create — the full setup chain

```ts
const { result } = await new CampaignFactory({ algorand, defaultSender, defaultSigner }).send.create.create({
  args: { vault: vaultAppId(), title, metadataUri, goal, deadline },
  appReferences: [vaultAppId()],
})

// fund(): 0.2 ALGO storage deposit (escrow MBR: base + Claim ASA opt-in).
await client.send.fund({ args: { payment }, extraFee: microAlgos(1000) })

// factory.register(): official-campaign proof; ~0.019 ALGO refundable deposit.
await factoryClient.send.register({ args: { app: appId, payment }, appReferences: [appId] })

// The vault issues the Claim ASA; the campaign attaches it (self-opt-in); the vault seeds the supply.
await vaultClient.send.issueClaimAsa({ args: { app: appId }, appReferences: [appId, factoryAppId()], extraFee: microAlgos(1000) })
const claimAsa = await vaultClient.state.box.asaOf.value(appId)
await client.send.attachClaimAsa({
  args: { asset: claimAsa }, appReferences: [vaultAppId()], assetReferences: [claimAsa], extraFee: microAlgos(1000),
})
await vaultClient.send.seedSupply({ args: { app: appId }, appReferences: [appId], assetReferences: [claimAsa], extraFee: microAlgos(1000) })
```

### pledge — opt-in, then payment to the vault + app call

```ts
const { optedIn } = await fetchClaimHolding(appId, address)
if (!optedIn) await algorand.send.assetOptIn({ sender: address, assetId: claimAsa })

await client.send.pledge({
  args: { payment },                      // backer -> VAULT, the pledge amount
  appReferences: [vaultAppId()],          // the campaign reads the vault's address
  assetReferences: [claimAsa],            // the inner mint references the Claim ASA
  extraFee: microAlgos(1000),
})
```

### claim — the vault pays from unit conservation

```ts
await client.send.claim({
  args: [],
  appReferences: [vaultAppId()],          // inner call target
  assetReferences: [claimAsa],            // the vault reads holdings
  boxReferences: vaultBoxRefs(appId, ['a', 'd', 'o', 's']),  // the vault's boxes touched by the inner call
  extraFee: microAlgos(2000),             // inner app call + inner payment
})
```

### refund / cancelPledge — surrender claim units to the vault

While the campaign is alive, the campaign drives the payout (inner app call to
the vault):

```ts
const axfer = await algorand.createTransaction.assetTransfer({
  sender: address, assetId: claimAsa, receiver: vaultAddress(), amount: balance,
})
await client.send.refund({
  args: { axfer },
  appReferences: [vaultAppId()],
  boxReferences: vaultBoxRefs(appId, ['a', 'd']),   // the vault's boxes the inner payBack touches
  extraFee: microAlgos(2000),
})
// …or client.send.cancelPledge({ … same shape … })
```

Once a **failed campaign has been deleted** (the indexer reports
`application.deleted === true`), the refund goes **directly through the vault**
— permanent, permissionless, campaign-independent:

```ts
await vaultClient.send.refund({ args: { app: appId, axfer }, appReferences: [appId], extraFee: microAlgos(1000) })
```

### closeOut — dump worthless units after a successful claim

```ts
const axfer = await algorand.createTransaction.assetTransfer({
  sender: address, assetId: claimAsa, receiver: vaultAddress(),
  amount: 0n, closeAssetTo: vaultAddress(),   // note: `closeAssetTo`, not `closeRemainderTo`
})
await client.send.closeOut({ args: { axfer }, appReferences: [vaultAppId()] })
```

### deleteCampaign — settle + sweep + unregister, one O(1) call

```ts
await client.send.delete.delete({             // the generated client nests delete
  args: [],
  appReferences: [vaultAppId()],
  assetReferences: claimAsa !== undefined ? [claimAsa] : [],
  boxReferences: claimAsa !== undefined ? vaultBoxRefs(appId, ['a', 'd', 's']) : [],
  extraFee: microAlgos(claimAsa !== undefined ? 3000 : 1000),
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

A failed campaign keeps the backers' funds at the vault until they reclaim them,
and a refund is itself a transaction the backer signs and pays for. The UI
states the estimated network fee beside every money-moving action:

| Action | Transactions | Estimated network fee |
| --- | --- | --- |
| `pledge()` (first time) | 1 opt-in + 1 payment + 1 app call + 1 inner axfer | ≈ 0.004 ALGO |
| `pledge()` (re-pledge) | 1 payment + 1 app call + 1 inner axfer | ≈ 0.003 ALGO |
| `refund()` / `cancelPledge()` | 1 axfer + 1 app call + 1 inner app call + 1 inner payment | ≈ 0.004 ALGO |
| `refund()` via the vault (post-delete) | 1 axfer + 1 vault call + 1 inner payment | ≈ 0.003 ALGO |
| `closeOut()` | 1 axfer + 1 app call | ≈ 0.002 ALGO |
| `delete()` | 1 app call + 2–3 inner txns (+ 1 unregister call) | ≈ 0.003–0.004 ALGO |

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
- **Opt-in race.** Two tabs pledging at once can double-opt-in; the opt-in
  check-then-send is best-effort and a failed opt-in just surfaces an error.
- **Close-out needs the exact `closeAssetTo` parameter** (asset transfers use
  `closeAssetTo`, not `closeRemainderTo`).
- **The Factory and the vault must be funded.** `register()` needs the Factory's
  app account to hold the registration deposits; the vault's app account holds
  the pooled pledges plus its parked per-campaign MBR. The deploy scripts fund
  both once.
- **`VITE_FACTORY_APP_ID` / `VITE_VAULT_APP_ID`.** The browse filter and every
  pledge/refund depend on these env vars matching the deployed apps; an empty
  Factory id disables the official-campaign filter.
- **Inner vault calls need box references.** `claim()`, `refund()`,
  `cancelPledge()`, and `delete()` inner-call the vault, whose BoxMap reads and
  writes require the box names to be declared on the outer transaction
  (`boxReferences` built from the vault app id + the campaign app id) — the
  AVM rejects undeclared box access. The vault's own methods get their boxes
  auto-populated from the ARC-56 spec.
- **The vault address is the pledge receiver.** `pledge()` rejects payments
  sent anywhere else, so the helper derives the address from
  `algosdk.getApplicationAddress(VITE_VAULT_APP_ID)`.
- **Suppress pledge readout on `claimed`.** `closeOut()` removes the units, so
  the detail view's "Your pledge" reflects the live balance naturally.

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
- **Claim units** are microAlgo-denominated (1 unit = 1 µA, 0 decimals) and are
  displayed as ALGO alongside pledges.

## Testing (Vitest)

The frontend has its own Vitest config (jsdom environment) plus
`@testing-library/react` and `@vitest/coverage-v8`. Run with `npm run test`;
coverage via `npm run test:coverage`.

Coverage gates **components and utils** (the app shell and generated clients are
excluded), with thresholds of 90% across lines/branches/functions/statements:

- `lib/format.ts` — ALGO/microAlgo conversion, deadline/countdown formatting.
- `lib/campaign.ts` — global-state decoding, status derivation, Claim ASA reads,
  Factory box decoding, and the indexer-backed read helpers.
- `lib/algorand.ts` / `lib/transaction.ts` — client singletons and the
  create/fund/register/pledge/claim/refund/cancel/closeOut/delete helpers
  (mocked at the `CampaignClient`/`FactoryClient` boundary).
- `features/campaigns/*` and the rest of `features/app/Nav`, `components/*`,
  `utils/*`.

Component tests mock `@txnlab/use-wallet-react` (wallet context) and the
indexer/client services via `vi.mock`.

## Out of scope for now

- Campaign metadata — implemented (hybrid, see [Campaign metadata](#campaign-metadata)); rich media/IPFS rendering is on the roadmap.
- TestNet deployment — on the roadmap.
- Backend / database — optional catalog only; the indexer + Factory are the read model.
