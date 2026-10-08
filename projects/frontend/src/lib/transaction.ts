import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import { getApplicationAddress } from 'algosdk'
import { CampaignClient, CampaignFactory } from '../contracts/Campaign'
import { ClaimsVaultClient } from '../contracts/ClaimsVault'
import { FactoryClient } from '../contracts/Factory'
import { algorand, waitForIndexerCatchUp, waitForIndexerRound } from './algorand'
import { factoryAppId, vaultAppId } from './campaign'
import { frontierForPledge, fetchMyLeaves as loadBackerLeaves, loadTree, pathBlobForRefund } from './claimtree'

/**
 * Write path: assembles + signs transactions through the generated `CampaignClient`, `ClaimsVaultClient`, and
 * `FactoryClient`, plus a manual composer for the two-app pledge group. Each helper takes the wallet's signer/address
 * so the wallet — never the app — holds the keys.
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

/** A backer's live leaf: position, amount, and payment TxID for proofs. */
export interface BackerLeaf {
  position: number
  amount: bigint
  txidHex: string
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

// The Factory registration deposit: the registration box's minimum balance, returned by `unregister()`.
const REGISTER_DEPOSIT_MICRO_ALGOS = 18_900n

// Fee headroom per call (measured on LocalNet — see docs/campaign.md "Minimum balances"): the outer call always covers
// its inners via fee pooling, so every extra inner transaction costs one more minimum fee on the outer call.
const FEE_CREDIT_EXTRA = 1_000n // possible first-touch factory check
const FEE_SPEND_EXTRA = 3_000n // 1 OpUp iteration (create+delete) + payout call
const FEE_CLAIM_EXTRA = 2_000n // inner payClaim + inner payment
const FEE_DELETE_EXTRA = 2_000n // inner settle/notify + escrow close
const FEE_UNREGISTER_EXTRA = 1_000n // inner deposit-back

// Contract error fragments that mean "rebuilt tree state moved under us" — safe to retry once with fresh proofs.
const STALE_PROOF_PATTERN = /stale or forged frontier|proof does not match root/

function campaignClientFor(appId: bigint, session: WalletSession): CampaignClient {
  return new CampaignClient({
    algorand,
    appId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

function vaultClientFor(session: WalletSession): ClaimsVaultClient {
  return new ClaimsVaultClient({
    algorand,
    appId: vaultAppId(),
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

function factoryClientFor(session: WalletSession): FactoryClient {
  return new FactoryClient({
    algorand,
    appId: factoryAppId(),
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

/**
 * The vault's campaign box reference (key prefix 'c' + 8-byte big-endian app id) — inner vault calls require it
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
  return [{ appId: vaultAppId(), name: new Uint8Array([0x63, ...appIdBytes]) }]
}

/**
 * The Factory's registration box for a campaign (prefix 'r' + 8-byte big-endian app id) — the inner `isRegistered`
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
  return [{ appId: factoryAppId(), name: new Uint8Array([0x72, ...appIdBytes]) }]
}

/**
 * The vault app's account address (where pledges go).
 *
 * @returns The vault's app account address.
 */
export function vaultAddress(): string {
  return getApplicationAddress(vaultAppId()).toString()
}

/**
 * Read and unpack a campaign's vault box (fresh from algod — routing decisions must not use stale indexer state).
 *
 * @param appId Campaign application id.
 * @returns The unpacked box, or undefined when no box exists yet.
 */
export async function fetchVaultBox(appId: bigint): Promise<VaultBoxView | undefined> {
  const vaultClient = new ClaimsVaultClient({ algorand, appId: vaultAppId() })
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
  const vaultClient = new ClaimsVaultClient({ algorand, appId: vaultAppId() })
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
    return await run()
  } catch (error) {
    if (error instanceof Error && STALE_PROOF_PATTERN.test(error.message)) {
      return await run()
    }
    throw error
  }
}

/**
 * Deploy a new campaign: create → register with the Factory. Nothing is funded — the v2 escrow never holds funds.
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
  const factory = new CampaignFactory({
    algorand,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })

  const sendResult = await factory.send.create.create({
    args: {
      vault: vaultAppId(),
      title: new TextEncoder().encode(title),
      metadataUri: new TextEncoder().encode(metadataUri),
      goal: goalMicroAlgos,
      deadline: deadlineSeconds,
    },
    appReferences: [vaultAppId()],
  })

  const appId = sendResult.result.appId

  // Register with the Factory (when configured) so the browse page treats the campaign as official. First-touch
  // credit verifies registration on-chain, so an unregistered campaign can never take pledges.
  if (factoryAppId() > 0n) {
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
 * Pledge ALGO: one atomic group `[pay, campaign.pledge, vault.credit]` with a freshly rebuilt frontier. Retries once
 * when a concurrent pledge moved the frontier under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 */
export async function pledge(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<void> {
  // The manual composer resolves signers by sender address — register the wallet signer for this address first.
  algorand.account.setSigner(session.address, session.signer)

  const attempt = async (): Promise<bigint | undefined> => {
    const tree = await loadTree(appId, vaultAppId(), vaultAddress())
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
        appReferences: [factoryAppId()],
        boxReferences: [...vaultBoxRef(appId), ...factoryRegistrationBox(appId)],
        extraFee: microAlgos(FEE_CREDIT_EXTRA),
      }),
    )
    await composer.send()
    return undefined
  }

  await submitWithFreshProof(attempt)
  await waitForIndexerCatchUp()
}

/**
 * The viewer's live pledge leaves for a campaign (positions, amounts, payment TxIDs for proofs).
 *
 * @param appId Campaign application id.
 * @param address Viewer address.
 * @returns Live leaves owned by the viewer.
 */
export async function fetchMyLeaves(appId: bigint, address: string): Promise<BackerLeaf[]> {
  return loadBackerLeaves(appId, vaultAppId(), vaultAddress(), address)
}

/**
 * Withdraw one pledge before the deadline (backer, while the campaign is still open). Rebuilds the path fresh and
 * retries once when a concurrent spend moved the root under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 */
export async function cancelPledge(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<void> {
  const attempt = async (): Promise<bigint | undefined> => {
    const tree = await loadTree(appId, vaultAppId(), vaultAddress())
    const client = campaignClientFor(appId, session)
    const result = await client.send.cancelPledge({
      args: {
        k: leaf.position,
        amount: leaf.amount,
        txid: Buffer.from(leaf.txidHex, 'hex'),
        path: pathBlobForRefund(tree, leaf.position),
      },
      sender: session.address,
      appReferences: [vaultAppId()],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(FEE_SPEND_EXTRA),
    })
    return result.confirmation.confirmedRound
  }

  const confirmedRound = await submitWithFreshProof(attempt)
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Refund one pledge after a failed campaign. Routes by the vault box (fresh from algod): an `Open`/missing box goes
 * through the campaign, a `Failed` box goes straight to `vault.refund` (covers post-settle and post-delete). Rebuilds
 * the path fresh and retries once when a concurrent spend moved the root under us.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param leaf The leaf to spend (from `fetchMyLeaves`).
 */
export async function refund(appId: bigint, session: WalletSession, leaf: BackerLeaf): Promise<void> {
  const attempt = async (): Promise<bigint | undefined> => {
    const tree = await loadTree(appId, vaultAppId(), vaultAddress())
    const path = pathBlobForRefund(tree, leaf.position)
    const txid = Buffer.from(leaf.txidHex, 'hex')
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
      appReferences: [vaultAppId()],
      boxReferences: vaultBoxRef(appId),
      extraFee: microAlgos(FEE_SPEND_EXTRA),
    })
    return result.confirmation.confirmedRound
  }

  const confirmedRound = await submitWithFreshProof(attempt)
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
  const client = campaignClientFor(appId, session)
  const result = await client.send.claim({
    args: [],
    appReferences: [vaultAppId()],
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
 * and unregisters from the Factory (returning the registration deposit). One O(1) call on every path.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function deleteCampaign(appId: bigint, session: WalletSession): Promise<void> {
  const client = campaignClientFor(appId, session)

  const result = await client.send.delete.delete({
    args: [],
    appReferences: [vaultAppId()],
    boxReferences: vaultBoxRef(appId),
    extraFee: microAlgos(FEE_DELETE_EXTRA),
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }

  if (factoryAppId() > 0n) {
    const factoryClient = factoryClientFor(session)
    await factoryClient.send.unregister({
      args: { app: appId },
      appReferences: [appId],
      extraFee: microAlgos(FEE_UNREGISTER_EXTRA),
    })
  }
}
