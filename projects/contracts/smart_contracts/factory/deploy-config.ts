import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import { AppFactory } from '@algorandfoundation/algokit-utils/types/app-factory'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Deploys the platform's `Factory` application — the canonical campaign registry.
 *
 * The deployer is the Factory owner (the only account allowed to configure the official approval hash). The Factory's application account
 * is funded with 1 ALGO (the platform storage reserve: the account base plus headroom for registration deposits), and the official hash is
 * set to the SHA-256 of the compiled `Campaign` approval program so `register()` can tell official campaigns apart from copies.
 *
 * @returns The deployed Factory's app id — configure it as `VITE_FACTORY_APP_ID` in the frontend.
 */
export async function deploy() {
  const algorand = AlgorandClient.fromEnvironment()

  // Resolve the deployer account from the environment. On LocalNet this
  // auto-creates and funds a KMD wallet called `DEPLOYER`; on other networks it
  // reads the `DEPLOYER_MNEMONIC` env var.
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const specPath = path.resolve(__dirname, '../artifacts/factory/Factory.arc56.json')
  const appSpec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as Arc56Contract

  const factory = new AppFactory({ appSpec, algorand, defaultSender: deployer.addr })

  const { appClient } = await factory.send.create({
    method: 'create()void',
    args: [],
    sender: deployer.addr,
  })

  // Platform storage reserve: the Factory account base (0.1 ALGO) plus headroom; registration deposits add ~0.019 ALGO each and are paid
  // back on unregister, so the balance stays roughly constant.
  await algorand.send.payment({
    sender: deployer.addr,
    receiver: appClient.appAddress,
    amount: microAlgos(1_000_000n),
  })

  // The official Campaign approval-program hash: SHA-256 over the compiled approval program, exactly what `register()` verifies.
  const campaignTeal = fs.readFileSync(path.resolve(__dirname, '../artifacts/campaign/Campaign.approval.teal'), 'utf8')
  const compiled = await algorand.app.compileTeal(campaignTeal)
  const approvalHash = createHash('sha256').update(compiled.compiledBase64ToBytes).digest()

  await appClient.send.call({
    method: 'setApprovalHash(byte[])void',
    args: [approvalHash],
    sender: deployer.addr,
  })

  console.log(
    `Deployed Factory app ${appClient.appId.toString()} at ${appClient.appAddress.toString()}. ` +
      `Set VITE_FACTORY_APP_ID=${appClient.appId.toString()} in projects/frontend/.env.`,
  )
  return appClient.appId
}
