# SDK design

The chain layer leaves `projects/frontend/src/lib` and becomes a versioned package, `projects/sdk` (published as `@kasakame/sdk`). SDK-first: the frontend clarity work, the escape-hatch CLI, and third-party clients all consume this package instead of reimplementing proofs. Status: in progress — stages 1–7 landed; the migration stages at the end are the build order. Related roadmap items: the SDK/CLI steps under CI & packaging, on-chain headers, and the Frontend clarity section.

## Package identity and placement

- Location `projects/sdk/`. The AlgoKit workspace discovers `projects/*` entries through their `.algokit.toml`, so the SDK ships a minimal one (mirroring the backend's `[project.run]` entries) to take part in `algokit project run` and `bootstrap`.
- One package, not three. Split only when a consumer needs a subset — today nobody does.
- Version `0.1.0` while the contracts churn; follows the contracts' breaking changes.
- Reserve the `@kasakame` npm org early (free, prevents squatting).

## Design decisions

- **One explicit setup call instead of singletons.** The frontend's `lib/algorand.ts` reads Vite env and builds module singletons; an SDK cannot depend on Vite (Node has none) or React. The SDK exposes `configureSdk({ algorand, factoryAppId, vaultAppId })`, called once at startup by the frontend (with the client it already builds) and by the CLI (from env/flags). Everything else keeps its current shape.
- **Structural, framework-free types.** `WalletSession { address, signer }` already uses algosdk's `TransactionSigner` — no wallet dependency. Indexer/algod access goes through the configured `AlgorandClient`.
- **Generated clients are build output.** `*Client.ts` and `*.arc56.json` stay gitignored; `scripts/codegen.mjs` builds the contracts and copies them into `src/generated/` (also gitignored) before SDK build/publish and before local dev.
- **The SDK returns protocol-shaped data; views stay in the frontend.** `CampaignViewModel`, messages, navigation, and `disconnectQuietly` never move. The stale-proof *retry policy* moves (it's protocol: the CLI needs it); the error-to-*message* mapping stays (it's UI).
- **Upload auth stays out.** `backend.ts`/`profiles.ts` sign-in flows are backend-coupled, not chain logic.

## Module layout

```text
projects/sdk/
  package.json          # name @kasakame/sdk, version 0.1.0, exports → ./dist
  tsconfig.json         # strict trio copied; NodeNext module/resolution (portable ESM)
  tsconfig.build.json   # noEmit off, specs excluded → dist/
  eslint.config.mjs     # copied from frontend (minus react/tailwind)
  vitest.config.ts      # copied; same 100% gate (SDK = utils)
  scripts/codegen.mjs   # contracts build → copy clients + arc56 → src/generated/
  src/
    index.ts            # public exports only
    claim-tree.ts       # pure math + replay (moved as-is)
    campaigns.ts        # reads: browse/detail/vault (moved) + headers/discovery (new)
    transactions.ts     # writes: call assembly + retry (moved minus wallet bits)
    chain.ts            # configureSdk + indexer polling (moved from lib/algorand.ts)
    generated/          # gitignored codegen output
```

## Public API surface

Moved functions keep their names and signatures; new ones are marked. Only deliberate rename: `deriveStatus` becomes `getCampaignStatus` (clearer for outside consumers; frontend imports update).

### Pure tree math (`claim-tree.ts`, no network)

`ZERO_ROOT` (constant), `zeroLeaf()`, `hashPair(left, right)`, `u64be(value)` / `u64beDecode(value)`, `leafFor(backer, amount, txidHex)`, `emptyTree()`, `appendLeaf(state, pledge)`, `foldPeaks(peaks)`, `treeFrontier(state)`, `treeRoot(state)`, `nullLeaf(state, position, amount)`, `pathShape(n, k)`, `treePathFor(state, k)`, `concatHashes(parts)`, `frontierForPledge(state)`, `pathBlobForRefund(state, k)`, `base32ToBytes(input)`, plus types `PledgeRecord`, `TreeState`, `AuthPath`, `PledgeEvent`, `SpendEvent`. Vectors (`claimtree.vectors.ts`, generator script) move with the math.

### Replay and leaves (`claim-tree.ts`, configured indexer)

`fetchPledges(campaignId, vaultAddress)`, `fetchSpends(campaignId, vaultId)`, `loadTree(campaignId, vaultId, vaultAddress)`, `fetchMyLeaves(appId, address)` (the `transaction.ts` shape wins; the `vaultId`/`vaultAddress` variant folds into it via configured ids), plus `clearTreeCache()`.

### Campaign reads (`campaigns.ts`)

`fetchRegisteredCampaignIds(factoryId)`, `listCampaigns(viewerAddress?)`, `getCampaign(appId, nowSeconds, viewerAddress?)`, `fetchMyPledge(appId, address)`, `decodeGlobalState(app)`, `isCampaignApp(app)`, session memoization (`get/set/clearCachedCampaigns`).

### Headers and discovery (`campaigns.ts`, new)

```ts
interface CampaignHeader {
  id: bigint
  creator: string
  title: string
  metadataUri: string
  goalMicroAlgos: bigint
  deadlineSeconds: bigint
  /** Live pledge total; from globals, or vault paidIn − paidOut once deleted. */
  raisedMicroAlgos: bigint
  /** Raw on-chain status byte (open/failed/claimed), kept for completeness. */
  status: 'open' | 'failed' | 'claimed'
  /** True when the app is deleted (globals gone; fields recovered from history). */
  deleted: boolean
}

function getCampaignStatus(header: CampaignHeader, nowSeconds: bigint): 'open' | 'successful' | 'failed'
```

`enumerateCampaigns()` lists app IDs from factory registry boxes plus vault boxes (live and deleted-unfinalized alike). `fetchCampaignHeader(appId)` reads globals for live campaigns and decodes the creation transaction (selector stripped, tuple per the ARC-56 spec) for deleted ones. `getCampaignStatus` derives the display word: funded (claimed or goal-reached) maps to `successful`, past-deadline unfunded maps to `failed`, otherwise `open`. Raw `status`/`deleted` stay on the header for consumers that need them (creator claim reminders, audit views).

### Writes (`transactions.ts`)

`WalletSession`, `BackerLeaf`, `VaultBoxView`, `vaultAddress()`, `fetchVaultBox(appId)`, `fetchVaultConfig()`, `createCampaign(...)`, `pledge(appId, session, amountMicroAlgos)`, `cancelPledge(appId, session, leaf)`, `refund(appId, session, leaf)`, `claim(appId, session)`, `deleteCampaign(appId, session)` (create + factory register/unregister stay grouped as today), plus the exported stale-proof predicate for the frontend's error mapping.

### Chain plumbing (`chain.ts`)

`configureSdk({ algorand, factoryAppId, vaultAppId })`, `fetchChainTimestamp()`, `waitForIndexerRound(round, timeoutMs?, pollMs?)`, `waitForIndexerCatchUp(timeoutMs?, pollMs?)`.

## Conventions

Mirror the frontend: ESLint + Prettier config copies, strictest tsconfig trio, Vitest with the 100% line/branch/function gate, specs colocated (`*.spec.ts`) moving with their modules. Commit scope `sdk` (add to the allowed scopes in `AGENTS.md`, plus the `projects/sdk` layout line, as part of stage 2).

## Migration stages

Each stage is one commit (a stage may split further if the diff gets unwieldy), ending green in every affected project: format, lint, check-types, tests. During the migration the frontend consumes the SDK via `"@kasakame/sdk": "file:../sdk"` with an SDK build ahead of frontend typecheck/dev; once `0.1.0` is published, swapping that reference for the registry version is an isolated follow-up. Codegen is deliberately deferred to stage 9 — nothing before the writes needs generated clients.

1. **Land the design** - commit this document and link it from the README docs map.
2. **Scaffold** - package skeleton, configs, empty `src/index.ts` in `projects/sdk`; add the `sdk` commit scope and layout line to `AGENTS.md`.
3. **Pure math** - move the pure layer, vectors, generator script, and specs into the SDK. The frontend stays untouched.
4. **SDK CI lane** - add `sdk` to the lint/format/type-check and unit-test matrices and build the SDK in the build job; update [`ci.md`](ci.md).
5. **Frontend switch (math)** - add the `file:../sdk` dependency and build-ahead scripts, delete the local math, re-export from the SDK. This is where the file-dependency mechanics get verified (npm workspaces remain the fallback if `file:` + prebuilt `dist/` proves fragile).
6. **Chain plumbing** - `configureSdk`, both indexer waiters, and `fetchChainTimestamp` land in `chain.ts`; the frontend `algorand.ts` shrinks to building the `AlgorandClient` and calling `configureSdk`.
7. **Replay** - move `fetchPledges`, `fetchSpends`, `loadTree`, the consolidated `fetchMyLeaves`, and `clearTreeCache`; the frontend re-exports for its remaining consumers.
8. **Campaign reads** - registry reads, global-state decode, `fetchMyPledge`, `listCampaigns`, `getCampaign`, the session caches, and `deriveStatus` move with their names and signatures intact. The protocol-record reshape (dropping viewer fields) rides with the headers in stage 13.
9. **Codegen** - `scripts/codegen.mjs` builds the contracts (or reuses artifacts), copies the clients and `*.arc56.json` into `src/generated/`, and tags them for `tsc`.
10. **Writes** - move call assembly, retry, vault helpers, and `WalletSession` into `transactions.ts`; `disconnectQuietly` and the error-to-message mapping stay in the frontend. The largest diff - split it by operation group if review needs it.
11. **Drop linked clients** - remove `algokit project link`, `src/contracts`, the ts-nocheck script, and the CI `frontend-clients` artifact; `reclaim.ts` imports from the SDK.
12. **Enumeration** - `enumerateCampaigns` lists app ids from the Factory registry boxes and the vault boxes.
13. **Headers** - `fetchCampaignHeader`, including creation-transaction decode for deleted campaigns; reads return protocol records and the frontend composes its view models.
14. **Status** - `getCampaignStatus` and the `deriveStatus` rename; frontend imports update. The ended-list and My pledges switch rides here or lands separately.
15. **Publish prep** - `prepublishOnly` (contracts build → codegen → `tsc` emit), `files` including the arc56 specs, README, engines; reserve the npm org.
16. **Publish** - `0.1.0` to the public registry (manual step).
17. **CLI** - scaffold `projects/cli` as its own package (not inside the SDK) and port `reclaim.ts` onto the SDK; publish alongside.

## Open questions

- Versioning discipline once external consumers exist (semver-minor for additive SDK surface, major with any contract breaking change).
