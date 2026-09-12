import { microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSigner } from 'algosdk'
import algosdk from 'algosdk'
import { CampaignClient, CampaignFactory } from '../contracts/Campaign'
import { ClaimsVaultClient } from '../contracts/ClaimsVault'
import { FactoryClient } from '../contracts/Factory'
import { algorand, indexer, waitForIndexerCatchUp, waitForIndexerRound } from './algorand'
import { factoryAppId, fetchClaimAsaId, fetchClaimHolding, vaultAppId } from './campaign'

/**
 * Write path: assembles + signs transactions through the generated `CampaignClient`, `ClaimsVaultClient`, and `FactoryClient`. Each helper
 * takes the wallet's signer/address so the wallet — never the app — holds the keys.
 *
 * The split-vault design (see docs/campaign.md):
 *
 * - **Creation** chains create → fund (the escrow's fixed deposit) → factory.register → vault.issueClaimAsa → attachClaimAsa →
 *   vault.seedSupply.
 * - **Pledges pay the vault** (the pooled refund escrow), never the campaign escrow; the campaign mints claim units from its seeded
 *   supply.
 * - **Cancels/refunds** surrender claim units to the vault; while the campaign is alive the campaign drives the payout via an inner call;
 *   after a failed campaign is deleted, the backer refunds **directly from the vault** — permanent, permissionless refund rights.
 * - **Claims** are paid by the vault from unit conservation; **delete** is one O(1) call on both settlement paths.
 */

export interface WalletSession {
  address: string
  signer: TransactionSigner
}

// The creator fronts the escrow's fixed minimum balance (base 0.1 + Claim ASA opt-in 0.1 ALGO) so backers' pledges stay fully refundable.
// See docs/campaign.md "Minimum balances". Matches MIN_DEPOSIT in the contract.
const STORAGE_DEPOSIT_MICRO_ALGOS = 200_000n

// The Factory registration deposit: the registration box's minimum balance, returned by `unregister()`.
const REGISTER_DEPOSIT_MICRO_ALGOS = 18_900n

/**
 * The vault's box names for a campaign (key prefix + 8-byte big-endian app id) — inner app calls require them declared on the outer txn.
 *
 * @param appId The campaign application id.
 * @param prefixes The vault box key prefixes to reference.
 * @returns Box references for the vault app.
 */
function vaultBoxRefs(appId: bigint, prefixes: string[]): { appId: bigint; name: Uint8Array }[] {
  let remaining = appId
  const appIdBytes = new Uint8Array(8)
  for (let i = 7; i >= 0; i--) {
    appIdBytes[i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return prefixes.map((prefix) => ({
    appId: vaultAppId(),
    name: new Uint8Array([...new TextEncoder().encode(prefix), ...appIdBytes]),
  }))
}

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
 * The Factory's registration box for a campaign (prefix 'r' + 8-byte big-endian app id) — the inner `isRegistered` check needs it.
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
 * The vault app's account address (where pledges go and claim units return).
 *
 * @returns The vault's app account address.
 */
export function vaultAddress(): string {
  return algosdk.getApplicationAddress(vaultAppId()).toString()
}

/**
 * Deploy a new campaign: create → fund (storage deposit) → register with the Factory → issue the Claim ASA → attach it → seed its
 * supply to the escrow.
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
  const client = campaignClientFor(appId, session)

  // The deposit covers the escrow's fixed minimum balance; backers' pledges never touch the escrow.
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

  // Register with the Factory (when configured) so the browse page treats the campaign as official.
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

  // The vault issues the Claim ASA (the official-program hash AND the Factory registration are verified on-chain), the campaign
  // attaches it (self-opt-in + the vault records the attach), the vault seeds the supply.
  const vaultClient = vaultClientFor(session)
  await vaultClient.send.issueClaimAsa({
    args: { app: appId },
    appReferences: [appId, factoryAppId()],
    boxReferences: factoryRegistrationBox(appId),
    extraFee: microAlgos(2000),
  })
  const claimAsa = (await vaultClient.state.box.asaOf.value(appId)) as bigint
  await client.send.attachClaimAsa({
    args: { asset: claimAsa },
    appReferences: [vaultAppId()],
    assetReferences: [claimAsa],
    boxReferences: vaultBoxRefs(appId, ['a', 'd', 't']),
    extraFee: microAlgos(2000),
  })
  await vaultClient.send.seedSupply({
    args: { app: appId },
    appReferences: [appId],
    assetReferences: [claimAsa],
    extraFee: microAlgos(1000),
  })

  // The generated create result doesn't expose the confirmation round, so wait for the indexer to catch up to algod's current tip.
  await waitForIndexerCatchUp()

  return { appId, appAddress: sendResult.result.appAddress.toString() }
}

/**
 * Pledge ALGO: opt the wallet into the Claim ASA if needed, then pay the vault and receive claim units in one atomic group.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 * @param amountMicroAlgos Pledge amount in microAlgos.
 */
export async function pledge(appId: bigint, session: WalletSession, amountMicroAlgos: bigint): Promise<void> {
  const claimAsa = await requireClaimAsa(appId)

  const holding = await fetchClaimHolding(appId, session.address)
  if (!holding.optedIn) {
    await algorand.send.assetOptIn({ sender: session.address, assetId: claimAsa })
  }

  const client = campaignClientFor(appId, session)
  const result = await client.send.pledge({
    args: {
      payment: await algorand.createTransaction.payment({
        sender: session.address,
        receiver: vaultAddress(),
        amount: microAlgos(amountMicroAlgos),
      }),
    },
    appReferences: [vaultAppId()],
    assetReferences: [claimAsa],
    extraFee: microAlgos(1000),
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Claim the campaign funds (creator only, after deadline, goal reached). The vault pays from unit conservation.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function claim(appId: bigint, session: WalletSession): Promise<void> {
  const claimAsa = await requireClaimAsa(appId)
  const client = campaignClientFor(appId, session)
  const result = await client.send.claim({
    args: [],
    appReferences: [vaultAppId()],
    assetReferences: [claimAsa],
    boxReferences: vaultBoxRefs(appId, ['a', 'd', 'o', 's']),
    extraFee: microAlgos(2000),
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Refund the caller's whole pledge by surrendering all their claim units. While the campaign is alive the payout is driven through the
 * campaign; once a failed campaign has been deleted, the refund goes directly through the vault — permanent, permissionless.
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

  const axfer = await algorand.createTransaction.assetTransfer({
    sender: session.address,
    assetId: claimAsa,
    receiver: vaultAddress(),
    amount: balance,
  })

  // A deleted campaign can no longer drive the payout — the vault's settled-failed record serves the refund directly.
  const response = await indexer.lookupApplications(appId).do()
  const deleted = response.application?.deleted === true

  if (deleted) {
    const vaultClient = vaultClientFor(session)
    const result = await vaultClient.send.refund({
      args: { app: appId, axfer },
      appReferences: [appId],
      extraFee: microAlgos(1000),
    })
    const confirmedRound = result.confirmation.confirmedRound
    if (confirmedRound !== undefined) {
      await waitForIndexerRound(confirmedRound)
    }
    return
  }

  const client = campaignClientFor(appId, session)
  const result = await client.send.refund({
    args: { axfer },
    appReferences: [vaultAppId(), appId],
    boxReferences: vaultBoxRefs(appId, ['a', 'd']),
    extraFee: microAlgos(2000),
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

  const client = campaignClientFor(appId, session)
  const result = await client.send.cancelPledge({
    args: {
      axfer: await algorand.createTransaction.assetTransfer({
        sender: session.address,
        assetId: claimAsa,
        receiver: vaultAddress(),
        amount: balance,
      }),
    },
    appReferences: [vaultAppId(), appId],
    boxReferences: vaultBoxRefs(appId, ['a', 'd']),
    extraFee: microAlgos(2000),
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
  const client = campaignClientFor(appId, session)

  const result = await client.send.closeOut({
    args: {
      axfer: await algorand.createTransaction.assetTransfer({
        sender: session.address,
        assetId: claimAsa,
        receiver: vaultAddress(),
        amount: 0n,
        closeAssetTo: vaultAddress(),
      }),
    },
    appReferences: [vaultAppId()],
  })

  const confirmedRound = result.confirmation.confirmedRound
  if (confirmedRound !== undefined) {
    await waitForIndexerRound(confirmedRound)
  }
}

/**
 * Delete a settled campaign (creator only): settles the vault on the failed path, closes the escrow's claim holding to the vault and the
 * escrow to the creator, and unregisters from the Factory (returning the registration deposit). One O(1) call on both paths.
 *
 * @param appId Campaign application id.
 * @param session Wallet session holding the signer and address.
 */
export async function deleteCampaign(appId: bigint, session: WalletSession): Promise<void> {
  const client = campaignClientFor(appId, session)
  const claimAsa = await fetchClaimAsaId(appId)

  // The delete needs the Claim ASA and the vault's campaign boxes as references; a never-funded campaign has none.
  const result = await client.send.delete.delete({
    args: [],
    appReferences: [vaultAppId()],
    assetReferences: claimAsa !== undefined ? [claimAsa] : [],
    boxReferences: claimAsa !== undefined ? vaultBoxRefs(appId, ['a', 'd', 's']) : [],
    extraFee: microAlgos(claimAsa !== undefined ? 3000 : 1000),
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
