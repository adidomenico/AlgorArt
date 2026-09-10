import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import { CampaignClient, CampaignFactory } from '../contracts/Campaign'
import { FactoryClient } from '../contracts/Factory'
import { algorand, waitForIndexerCatchUp, waitForIndexerRound } from './algorand'
import { factoryAppId, fetchClaimAsaId, fetchClaimHolding } from './campaign'

/**
 * Write path: assembles + signs transactions through the generated `CampaignClient` and `FactoryClient`. Each helper takes the wallet's
 * signer/address so the wallet — never the app — holds the keys.
 *
 * The Claim ASA design changes the flow from the Merkle era:
 *
 * - `pledge` mints claim units to the backer, so the wallet opts into the Claim ASA first;
 * - `refund`/`cancelPledge` surrender claim units with a plain asset transfer (no proofs);
 * - `closeOut` returns the now-worthless units of a successful campaign and frees the backer's opt-in MBR;
 * - `deleteCampaign` also unregisters the campaign from the Factory.
 */

export interface WalletSession {
  address: string
  signer: TransactionSigner
}

// The creator fronts the escrow's fixed minimum balance (base 0.1 + created asset 0.1 ALGO) so backers' pledges stay fully refundable.
// See docs/campaign.md "Minimum balances". Matches MIN_DEPOSIT in the contract.
const STORAGE_DEPOSIT_MICRO_ALGOS = 200_000n

// The Factory registration deposit: the registration box's minimum balance, returned by `unregister()`.
const REGISTER_DEPOSIT_MICRO_ALGOS = 18_900n

function clientFor(appId: bigint, session: WalletSession): CampaignClient {
  return new CampaignClient({
    algorand,
    appId,
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
 * Deploy a new campaign, fund its storage deposit (which issues the Claim ASA), and register it with the Factory.
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

  // The deposit is a separate step: without it the escrow has no balance for the Claim ASA's minimum balance, so `fund()` issues the ASA.
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
    extraFee: microAlgos(1000),
  })

  // Register the campaign with the Factory (when configured) so the browse page treats it as official.
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
 * Pledge ALGO: opt the wallet into the Claim ASA if needed, then pay the escrow and receive claim units in one atomic group.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 */
export async function pledge(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<void> {
  const claimAsa = await fetchClaimAsaId(appId)
  if (claimAsa === undefined) {
    throw new Error('Campaign has no claim asset (has the creator funded it?)')
  }

  const holding = await fetchClaimHolding(appId, session.address)
  if (!holding.optedIn) {
    await algorand.send.assetOptIn({ sender: session.address, assetId: claimAsa })
  }

  const client = clientFor(appId, session)
  const result = await client.send.pledge({
    args: {
      payment: await algorand.createTransaction.payment({
        sender: session.address,
        receiver: client.appAddress,
        amount: microAlgos(amountMicroAlgos),
      }),
    },
    assetReferences: [claimAsa],
    extraFee: microAlgos(1000),
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
 * Refund the caller's whole pledge (backer, after deadline, goal not reached) by surrendering all their claim units.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function refund(appId: bigint, session: WalletSession): Promise<void> {
  const claimAsa = await requireClaimAsa(appId)
  const { balance } = await fetchClaimHolding(appId, session.address)
  if (balance <= 0n) {
    throw new Error('no claim units to refund')
  }

  const client = clientFor(appId, session)
  const result = await client.send.refund({
    args: {
      axfer: await algorand.createTransaction.assetTransfer({
        sender: session.address,
        assetId: claimAsa,
        receiver: client.appAddress,
        amount: balance,
      }),
    },
    extraFee: microAlgos(1000),
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Withdraw the caller's pledge before the deadline (backer, while the campaign is still open) by surrendering all their claim units.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function cancelPledge(appId: bigint, session: WalletSession): Promise<void> {
  const claimAsa = await requireClaimAsa(appId)
  const { balance } = await fetchClaimHolding(appId, session.address)
  if (balance <= 0n) {
    throw new Error('no claim units to cancel')
  }

  const client = clientFor(appId, session)
  const result = await client.send.cancelPledge({
    args: {
      axfer: await algorand.createTransaction.assetTransfer({
        sender: session.address,
        assetId: claimAsa,
        receiver: client.appAddress,
        amount: balance,
      }),
    },
    extraFee: microAlgos(1000),
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Close out the caller's claim holding on a successful campaign, recovering their 0.1 ALGO opt-in minimum balance. No payout.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function closeOut(appId: bigint, session: WalletSession): Promise<void> {
  const claimAsa = await requireClaimAsa(appId)
  const client = clientFor(appId, session)

  const result = await client.send.closeOut({
    args: {
      axfer: await algorand.createTransaction.assetTransfer({
        sender: session.address,
        assetId: claimAsa,
        receiver: client.appAddress,
        amount: 0n,
        closeAssetTo: client.appAddress,
      }),
    },
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Delete a settled campaign (creator only): destroys the Claim ASA, closes the escrow to the creator, and unregisters from the Factory
 * (returning the registration deposit).
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function deleteCampaign(appId: bigint, session: WalletSession): Promise<void> {
  const client = clientFor(appId, session)
  const claimAsa = await fetchClaimAsaId(appId)

  // The delete needs the Claim ASA as a foreign reference (the supply check and the destroy inner txn); a never-funded campaign has none.
  const result = await client.send.delete.delete({
    args: [],
    assetReferences: claimAsa !== undefined ? [claimAsa] : [],
    extraFee: microAlgos(claimAsa !== undefined ? 2000 : 1000),
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
      extraFee: microAlgos(1000),
    })
  }
}

/**
 * The campaign's Claim ASA id, throwing a friendly error when the campaign was never funded.
 *
 * @param appId Campaign application id.
 * @returns The Claim ASA id.
 */
async function requireClaimAsa(appId: bigint): Promise<bigint> {
  const claimAsa = await fetchClaimAsaId(appId)
  if (claimAsa === undefined) {
    throw new Error('Campaign has no claim asset (has the creator funded it?)')
  }
  return claimAsa
}
