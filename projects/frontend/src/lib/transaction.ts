import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import { CampaignClient, CampaignFactory } from '../contracts/Campaign'
import { algorand } from './algorand'

/**
 * Write path: assembles + signs transactions through the generated
 * `CampaignClient`. Each helper takes the wallet's signer/address so the
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

/** Deploy a new campaign. Returns the new app id and escrow address. */
export async function createCampaign(
  session: WalletSession,
  goalMicroAlgos: bigint,
  deadlineSeconds: bigint,
): Promise<{ appId: bigint; appAddress: string }> {
  const factory = new CampaignFactory({
    algorand,
    defaultSender: session.address,
    defaultSigner: session.signer,
  })

  const { result } = await factory.send.create.create({
    args: { goal: goalMicroAlgos, deadline: deadlineSeconds },
  })

  return { appId: result.appId, appAddress: result.appAddress.toString() }
}

/** Pledge ALGO: a payment to the escrow + the app call, in one atomic group. */
export async function pledge(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<void> {
  const client = clientFor(appId, session)

  await client.send.pledge({
    args: {
      payment: await algorand.createTransaction.payment({
        sender: session.address,
        receiver: client.appAddress,
        amount: microAlgos(amountMicroAlgos),
      }),
    },
    populateAppCallResources: true,
  })
}

/** Claim the escrow balance (creator only, after deadline, goal reached). */
export async function claim(appId: bigint, session: WalletSession): Promise<void> {
  const client = clientFor(appId, session)
  await client.send.claim({ args: [], coverAppCallInnerTransactionFees: true })
}

/** Refund the caller's pledge (backer, after deadline, goal not reached). */
export async function refund(appId: bigint, session: WalletSession): Promise<void> {
  const client = clientFor(appId, session)
  await client.send.refund({ args: [], coverAppCallInnerTransactionFees: true })
}
