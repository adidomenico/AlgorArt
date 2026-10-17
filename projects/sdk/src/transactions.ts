import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import { getApplicationAddress, hexToBytes } from 'algosdk'
import { getSdkConfig, waitForIndexerCatchUp, waitForIndexerRound } from './chain.js'
import type { BackerLeaf } from './claim-tree.js'
import { clearTreeCache, frontierForPledge, loadTree, pathBlobForRefund } from './claim-tree.js'
import { CampaignClient, CampaignFactory } from './generated/CampaignClient.js'
import { ClaimsVaultClient } from './generated/ClaimsVaultClient.js'
import { FactoryClient } from './generated/FactoryClient.js'

/**
 * Write path: assembles + signs transactions through the generated `CampaignClient`, `ClaimsVaultClient`, and
 * `FactoryClient`, plus a manual composer for the two-app pledge group. Each helper takes the wallet's signer/address
 * so the wallet - never the app - holds the keys.
 *
 * The claim-tree design (see docs/campaign.md):
 *
 * - **Creation** chains create → factory.register. Nothing is funded: the escrow never holds funds.
 * - **Pledges** are one atomic group `[pay, campaign.pledge, vault.credit]`; the caller supplies the frontier (rebuilt
 *   from the indexer right before submitting) and retries once on a stale-proof rejection.
 * - **Cancels/refunds** null one leaf per call (`vault.payBack` path while the campaign box is open, `vault.refund`
 *   directly once settled) with the path rebuilt fresh and one stale retry.
 * - **Claims** are paid by the vault from per-campaign balance guards; **delete** settles in O(1) on every path.
 * - There are no assets anywhere: no opt-ins, no balances, no close-outs.
 */

export interface WalletSession {
  address: string
  signer: TransactionSigner
}

/** Vault box settlement state for refund routing and the window banner. */
export interface VaultBoxView {
  paidIn: bigint
  paidOut: bigint
  /** 1 = Open, 2 = Failed, 3 = Claimed. */
  status: number
  /** Settlement timestamp (seconds, 0 before settlement). */
  settledAt: bigint
}

// Contract asserts for stale Merkle proofs (`campaign/contract.algo.ts`, `claimsvault/contract.algo.ts`): plain
// strings, but ours and stable - covered by contract tests when they change.
const STALE_PROOF_PATTERN = /stale or forged frontier|proof does not match root/i

/**
 * Whether a submission failed on a stale Merkle proof (a concurrent pledge/refund moved the root).
 *
 * @param error The failure from a chain submission.
 * @returns True when rebuilding proofs and retrying once is correct.
 */
export function isStaleProofError(error: unknown): boolean {
  return error instanceof Error && STALE_PROOF_PATTERN.test(error.message)
}

// The Factory registration deposit: the registration box's minimum balance, returned by `unregister()`.
const REGISTER_DEPOSIT_MICRO_ALGOS = 18_900n

// Fee headroom per call (measured on LocalNet - see docs/campaign.md "Minimum balances"): the outer call always covers
// its inners via fee pooling, so every extra inner transaction costs one more minimum fee on the outer call.
const FEE_CREDIT_EXTRA = 1_000n // possible first-touch factory check
const FEE_SPEND_EXTRA = 3_000n // 1 OpUp iteration (create+delete) + payout call
const FEE_CLAIM_EXTRA = 2_000n // inner payClaim + inner payment
const FEE_DELETE_EXTRA = 2_000n // inner settle/notify + escrow close
const FEE_UNREGISTER_EXTRA = 1_000n // inner deposit-back

function campaignClientFor(appId: bigint, session: WalletSession): CampaignClient {
  const { algorand } = getSdkConfig()
  return new CampaignClient({
    algorand,
    appId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

function vaultClientFor(session: WalletSession): ClaimsVaultClient {
  const { algorand, vaultAppId } = getSdkConfig()
  return new ClaimsVaultClient({
    algorand,
    appId: vaultAppId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

function factoryClientFor(session: WalletSession): FactoryClient {
  const { algorand, factoryAppId } = getSdkConfig()
  return new FactoryClient({
    algorand,
    appId: factoryAppId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

/**
 * The vault's campaign box reference (key prefix 'c' + 8-byte big-endian app id) - inner vault calls require it
 * declared on the outer transaction.
 *
 * @param appId The campaign application id.
 * @returns Box references for the vault app.
 */
function vaultBoxRef(appId: bigint): { appId: bigint; name: Uint8Array }[] {
  let remaining = appId
  const appIdBytes = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    appIdBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return [{ appId: getSdkConfig().vaultAppId, name: new Uint8Array([0x63, ...appIdBytes]) }]
}

/**
 * The Factory's registration box for a campaign (prefix 'r' + 8-byte big-endian app id) - the inner `isRegistered`
 * check needs it.
 *
 * @param appId The campaign application id.
 * @returns Box references for the Factory app.
 */
function factoryRegistrationBox(appId: bigint): { appId: bigint; name: Uint8Array }[] {
  let remaining = appId
  const appIdBytes = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    appIdBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return [{ appId: getSdkConfig().factoryAppId, name: new Uint8Array([0x72, ...appIdBytes]) }]
}

/**
 * The vault app's account address (where pledges go).
 *
 * @returns The vault's app account address.
 */
export function vaultAddress(): string {
  return getApplicationAddress(getSdkConfig().vaultAppId).toString()
}

/**
 * Read and unpack a campaign's vault box (fresh from algod - routing decisions must not use stale indexer state).
 *
 * @param appId Campaign application id.
 * @returns The unpacked box, or undefined when no box exists yet.
 */
export async function fetchVaultBox(appId: bigint): Promise<VaultBoxView | undefined> {
  const { algorand, vaultAppId } = getSdkConfig()
  const vaultClient = new ClaimsVaultClient({ algorand, appId: vaultAppId })
  let raw: Uint8Array
  try {
    raw = (await vaultClient.state.box.campaignBox.value(appId)) as Uint8Array
  } catch {
    return undefined
  }
  if (raw.length !== 65) return undefined
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  return {
    paidIn: view.getBigUint64(0),
    paidOut: view.getBigUint64(8),
    // The length check above guarantees byte 56 exists; the fallback satisfies noUncheckedIndexedAccess.
    /* v8 ignore next */
    status: raw[56] ?? 0,
    settledAt: view.getBigUint64(57),
  }
}

/**
 * The vault's configured refund window (seconds), for the refund-window banner.
 *
 * @returns The window in seconds and the sweep target address.
 */
export async function fetchVaultConfig(): Promise<{ window: bigint; sweepTarget: string }> {
  const { algorand, vaultAppId } = getSdkConfig()
  const vaultClient = new ClaimsVaultClient({ algorand, appId: vaultAppId })
  const window = (await vaultClient.state.global.refundWindow()) as bigint
  const sweepTarget = (await vaultClient.state.global.sweepTarget()) as string
  return { window, sweepTarget }
}

/**
 * Run a proof-carrying submission, rebuilding proofs once when the tree moved under us (concurrent pledge/refund
 * changed the root between our read and our submit). Anything else throws immediately.
 *
 * @param run Builds fresh proofs from a fresh tree, then submits. Called up to twice.
 * @returns The confirmed round, if exposed.
 */
async function submitWithFreshProof(run: () => Promise<bigint | undefined>): Promise<bigint | undefined> {
  try {
    clearTreeCache()
    return await run()
  } catch (error) {
    if (isStaleProofError(error)) {
      clearTreeCache()
      return await run()
    }
    throw error
  }
}

/**
 * Deploy a new campaign: create → register with the Factory. Nothing is funded - the v2 escrow never holds funds.
 *
 * @param session Wallet session holding the signer and address.
 * @param title Short campaign title (stored on-chain).
 * @param metadataUri URI of the off-chain campaign metadata.
 * @param goalMicroAlgos Funding target in microAlgos.
 * @param deadlineSeconds Deadline as a UNIX timestamp (seconds).
 * @returns The new app id and escrow address.
 */
export async function createCampaign(
  session: WalletSession,
  title: string,
  metadataUri: string,
  goalMicroAlgos: bigint,
  deadlineSeconds: bigint,
): Promise<{ appId: bigint; appAddress: string }> {
  const { algorand, factoryAppId, vaultAppId } = getSdkConfig()
  const factory = new CampaignFactory({
    algorand,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })

  const sendResult = await factory.send.create.create({
    args: {
      vault: vaultAppId,
      title: new TextEncoder().encode(title),
      metadataUri: new TextEncoder().encode(metadataUri),
      goal: goalMicroAlgos,
      deadline: deadlineSeconds,
    },
    appReferences: [vaultAppId],
  })

  const appId = sendResult.result.appId

  // Register with the Factory (when configured) so the browse page treats the campaign as official. First-touch
  // credit verifies registration on-chain, so an unregistered campaign can never take pledges.
  if (factoryAppId > 0n) {
    const factoryClient = factoryClientFor(session)
    await factoryClient.send.register({
      args: {
        app: appId,
        payment: await algorand.createTransaction.payment({
          sender: session.address,
          receiver: factoryClient.appAddress,
          amount: microAlgos(REGISTER_DEPOSIT_MICRO_ALGOS),
        }),
      },
      appReferences: [appId],
    })
  }

  // The generated create result doesn't expose the confirmation round, so wait for the indexer to catch up to algod's current tip.
  await waitForIndexerCatchUp()

  return { appId, appAddress: sendResult.result.appAddress.toString() }
}

/**
 * Pledge ALGO: one atomic group `[pay, campaign.pledge, vault.credit]` with a freshly rebuilt frontier. Waits for the
 * indexer to catch up before building proofs (a lagging indexer is the usual cause of stale first attempts, each of
 * which costs the user an approval plus burned fees). Retries once when a concurrent pledge moved the frontier
 * under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 */
export async function pledge(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<void> {
  const { algorand, factoryAppId, vaultAppId } = getSdkConfig()
  // The manual composer resolves signers by sender address - register the wallet signer for this address first.
  algorand.account.setSigner(session.address, session.signer)

  const attempt = async (): Promise<bigint | undefined> => {
    await waitForIndexerCatchUp()
    const tree = await loadTree(appId, vaultAppId, vaultAddress())
    const campaignClient = campaignClientFor(appId, session)
    const vaultClient = vaultClientFor(session)
    const composer = algorand.send.newGroup()
    composer.addAppCallMethodCall(
      await campaignClient.params.pledge({
        args: {
          payment: await algorand.createTransaction.payment({
            sender: session.address,
            receiver: vaultAddress(),
            amount: microAlgos(amountMicroAlgos),
          }),
          frontier: frontierForPledge(tree),
        },
        sender: session.address,
      }),
    )
    composer.addAppCallMethodCall(
      await vaultClient.params.credit({
        args: { app: appId, amount: amountMicroAlgos },
        sender: session.address,
        appReferences: [factoryAppId],
        boxReferences: [...vaultBoxRef(appId), ...factoryRegistrationBox(appId)],
        extraFee: microAlgos(FEE_CREDIT_EXTRA),
      }),
    )
    await composer.send()
    return undefined
  }

  await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  await waitForIndexerCatchUp()
}

/**
 * Withdraw one pledge before the deadline (backer, while the campaign is still open). Waits for the indexer to
 * catch up before rebuilding the path (see pledge), then retries once when a concurrent spend moved the root
 * under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 */
export async function cancelPledge(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<void> {
  const { algorand, vaultAppId } = getSdkConfig()
  // The AppClient drops defaultSigner when sender is passed explicitly (string vs Address identity check),
  // so register globally like pledge/delete do - otherwise this always throws "No signer found".
  algorand.account.setSigner(session.address, session.signer)
  const attempt = async (): Promise<bigint | undefined> => {
    await waitForIndexerCatchUp()
    const tree = await loadTree(appId, vaultAppId, vaultAddress())
    const client = campaignClientFor(appId, session)
    const result = await client.send.cancelPledge({
      args: {
        k: leaf.position,
        amount: leaf.amount,
        txid: hexToBytes(leaf.txidHex),
        path: pathBlobForRefund(tree, leaf.position),
      },
      sender: session.address,
      appReferences: [vaultAppId],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(FEE_SPEND_EXTRA),
    })
    return result.confirmation.confirmedRound
  }

  const confirmedRound = await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Refund one pledge after a failed campaign. Routes by the vault box (fresh from algod): an `Open`/missing box goes
 * through the campaign, a `Failed` box goes straight to `vault.refund` (covers post-settle and post-delete). Waits
 * for the indexer to catch up before rebuilding the path (see pledge), then retries once when a concurrent spend
 * moved the root under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 */
export async function refund(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<void> {
  const { algorand, vaultAppId } = getSdkConfig()
  // Same signer registration as cancelPledge (see above): without it both the campaign and vault paths fail.
  algorand.account.setSigner(session.address, session.signer)
  const attempt = async (): Promise<bigint | undefined> => {
    await waitForIndexerCatchUp()
    const tree = await loadTree(appId, vaultAppId, vaultAddress())
    const path = pathBlobForRefund(tree, leaf.position)
    const txid = hexToBytes(leaf.txidHex)
    const box = await fetchVaultBox(appId)
    if (box !== undefined && box.status === 2) {
      const vaultClient = vaultClientFor(session)
      const result = await vaultClient.send.refund({
        args: { app: appId, k: leaf.position, amount: leaf.amount, txid, path },
        sender: session.address,
        boxReferences: vaultBoxRef(appId),
        extraFee: microAlgos(FEE_SPEND_EXTRA),
      })
      return result.confirmation.confirmedRound
    }

    const client = campaignClientFor(appId, session)
    const result = await client.send.refund({
      args: { k: leaf.position, amount: leaf.amount, txid, path },
      sender: session.address,
      appReferences: [vaultAppId],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(FEE_SPEND_EXTRA),
    })
    return result.confirmation.confirmedRound
  }

  const confirmedRound = await submitWithFreshProof(attempt)
  // Our own write superseded the cache: drop it so the UI reload below refetches.
  clearTreeCache()
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Claim the campaign funds (creator only, after deadline, goal reached). The vault pays the derived live total.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function claim(appId: bigint, session: WalletSession): Promise<void> {
  const { algorand, vaultAppId } = getSdkConfig()
  // Same signer registration as pledge (see cancelPledge): without it the send always throws "No signer found".
  algorand.account.setSigner(session.address, session.signer)
  const client = campaignClientFor(appId, session)
  const result = await client.send.claim({
    args: [],
    appReferences: [vaultAppId],
    boxReferences: vaultBoxRef(appId),
    extraFee: microAlgos(FEE_CLAIM_EXTRA),
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Delete a settled campaign (creator only): settles the vault on the failed path, closes the escrow to the creator,
 * and unregisters from the Factory (returning the registration deposit). One atomic group (one wallet approval):
 * unregister runs first so every app reference resolves while the campaign app still exists; atomicity makes the
 * order irrelevant to the outcome.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function deleteCampaign(appId: bigint, session: WalletSession): Promise<void> {
  const { algorand, factoryAppId, vaultAppId } = getSdkConfig()
  const client = campaignClientFor(appId, session)
  // The manual composer resolves signers by sender address - register the wallet signer for this address first.
  algorand.account.setSigner(session.address, session.signer)
  const composer = algorand.send.newGroup()
  if (factoryAppId > 0n) {
    const factoryClient = factoryClientFor(session)
    composer.addAppCallMethodCall(
      await factoryClient.params.unregister({
        args: { app: appId },
        sender: session.address,
        appReferences: [appId],
        extraFee: microAlgos(FEE_UNREGISTER_EXTRA),
      }),
    )
  }
  composer.addAppCallMethodCall(
    await client.params.delete.delete({
      args: [],
      sender: session.address,
      appReferences: [vaultAppId],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(FEE_DELETE_EXTRA),
    }),
  )
  await composer.send()
  await waitForIndexerCatchUp()
}
