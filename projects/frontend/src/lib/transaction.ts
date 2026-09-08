import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import { decodeAddress } from 'algosdk'
import { CampaignClient, CampaignFactory } from '../contracts/Campaign'
import { algorand, waitForIndexerCatchUp, waitForIndexerRound } from './algorand'
import type { LiveLeaf } from './campaign'
import { fetchPledgesForBacker } from './campaign'
import { leafHash, proofBytes } from './merkle'

/**
 * Write path: assembles + signs transactions through the generated `CampaignClient`. Each helper takes the wallet's signer/address so the
 * wallet — never the app — holds the keys.
 */

export interface WalletSession {
  address: string
  signer: TransactionSigner
}

// The creator fronts the escrow's fixed storage MBR (app base + frontier box + all four spent shards) so backers' pledges stay fully
// refundable. See docs/campaign.md "The storage deposit". Matches MIN_DEPOSIT in the contract integration tests.
const STORAGE_DEPOSIT_MICRO_ALGOS = 2_303_300n

function clientFor(appId: bigint, session: WalletSession): CampaignClient {
  return new CampaignClient({
    algorand,
    appId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

/**
 * Deploy a new campaign and fund its storage deposit. Returns the new app id and escrow address.
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
      title: new TextEncoder().encode(title),
      metadataUri: new TextEncoder().encode(metadataUri),
      goal: goalMicroAlgos,
      deadline: deadlineSeconds,
    },
  })

  // The deposit is a separate step now: without it the first pledge cannot create the frontier box (insufficient balance).
  const appId = sendResult.result.appId
  const client = clientFor(appId, session)
  await client.send.fund({
    args: {
      payment: await algorand.createTransaction.payment({
        sender: session.address,
        receiver: client.appAddress,
        amount: microAlgos(STORAGE_DEPOSIT_MICRO_ALGOS),
      }),
    },
  })

  // The generated create result doesn't expose the confirmation round, so wait for the indexer to catch up to algod's current tip.
  await waitForIndexerCatchUp()

  return { appId, appAddress: sendResult.result.appAddress.toString() }
}

/**
 * Pledge ALGO: a payment to the escrow + the app call, in one atomic group.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 */
export async function pledge(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<void> {
  const client = clientFor(appId, session)

  const result = await client.send.pledge({
    args: {
      payment: await algorand.createTransaction.payment({
        sender: session.address,
        receiver: client.appAddress,
        amount: microAlgos(amountMicroAlgos),
      }),
    },
    populateAppCallResources: true,
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Claim the escrow balance (creator only, after deadline, goal reached).
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function claim(appId: bigint, session: WalletSession): Promise<void> {
  const client = clientFor(appId, session)
  const result = await client.send.claim({ args: [], extraFee: microAlgos(1000) })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Reconstruct the campaign's tree and the backer's live leaves, then hash every leaf so proofs can be generated.
 *
 * @param appId Campaign application id.
 * @param address The backer's address.
 * @returns The leaf hashes (in slot order) and the backer's live leaves.
 */
async function prepareProofs(appId: bigint, address: string): Promise<{ leafHashes: Uint8Array[]; live: LiveLeaf[] }> {
  const { leaves, live } = await fetchPledgesForBacker(appId, address)
  if (live.length === 0) {
    throw new Error('no live pledge to act on')
  }
  const leafHashes = await Promise.all(leaves.map((leaf) => leafHash(decodeAddress(leaf.address).publicKey, leaf.amount)))
  return { leafHashes, live }
}

/**
 * Refund the caller's pledge (backer, after deadline, goal not reached). Each live leaf is refunded with its own Merkle proof.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function refund(appId: bigint, session: WalletSession): Promise<void> {
  const { leafHashes, live } = await prepareProofs(appId, session.address)
  const client = clientFor(appId, session)

  for (const leaf of live) {
    const proof = await proofBytes(leafHashes, leaf.index)
    const result = await client.send.refund({ args: { proof, index: leaf.index, amount: leaf.amount }, extraFee: microAlgos(1000) })
    const confirmedRound = result.confirmation.confirmedRound
    if (confirmedRound !== undefined) {
      await waitForIndexerRound(confirmedRound)
    }
  }
}

/**
 * Withdraw the caller's pledge before the deadline (backer, while the campaign is still open). Each live leaf is withdrawn with its own
 * Merkle proof.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function cancelPledge(appId: bigint, session: WalletSession): Promise<void> {
  const { leafHashes, live } = await prepareProofs(appId, session.address)
  const client = clientFor(appId, session)

  for (const leaf of live) {
    const proof = await proofBytes(leafHashes, leaf.index)
    const result = await client.send.cancelPledge({ args: { proof, index: leaf.index, amount: leaf.amount }, extraFee: microAlgos(1000) })
    const confirmedRound = result.confirmation.confirmedRound
    if (confirmedRound !== undefined) {
      await waitForIndexerRound(confirmedRound)
    }
  }
}
