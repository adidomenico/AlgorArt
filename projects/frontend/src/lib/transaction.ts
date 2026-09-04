import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import { CampaignClient, CampaignFactory } from '../contracts/Campaign'
import { algorand, waitForIndexerCatchUp, waitForIndexerRound } from './algorand'

/**
 * Write path: assembles + signs transactions through the generated `CampaignClient`. Each helper takes the wallet's signer/address so the
 * wallet — never the app — holds the keys.
 */

export interface WalletSession {
  address: string
  signer: TransactionSigner
}

function clientFor(appId: bigint, session: WalletSession): CampaignClient {
  return new CampaignClient({
    algorand,
    appId,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })
}

/**
 * Deploy a new campaign. Returns the new app id and escrow address.
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

  // The generated create result doesn't expose the confirmation round, so wait for the indexer to catch up to algod's current tip.
  await waitForIndexerCatchUp()

  return { appId: sendResult.result.appId, appAddress: sendResult.result.appAddress.toString() }
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
  const result = await client.send.claim({ args: [], coverAppCallInnerTransactionFees: true })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Refund the caller's pledge (backer, after deadline, goal not reached).
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function refund(appId: bigint, session: WalletSession): Promise<void> {
  const client = clientFor(appId, session)
  const result = await client.send.refund({ args: [], coverAppCallInnerTransactionFees: true })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Withdraw the caller's pledge before the deadline (backer, while the campaign is still open).
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function cancelPledge(appId: bigint, session: WalletSession): Promise<void> {
  const client = clientFor(appId, session)
  const result = await client.send.cancelPledge({ args: [], coverAppCallInnerTransactionFees: true })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}
