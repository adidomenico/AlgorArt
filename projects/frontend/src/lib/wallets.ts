import type { WalletAdapterConfig } from '@txnlab/use-wallet'
import { WalletManager } from '@txnlab/use-wallet'
import { defly } from '@txnlab/use-wallet-defly'
import { exodus } from '@txnlab/use-wallet-exodus'
import { kmd } from '@txnlab/use-wallet-kmd'
import { pera } from '@txnlab/use-wallet-pera'
import { getAlgodConfigFromViteEnvironment, getKmdConfigFromViteEnvironment } from '../utils/network/getAlgoClientConfigs'

let cachedManager: WalletManager | undefined

/**
 * The shared wallet manager, created once on first use. It must not be constructed during render: every render
 * would create a fresh manager, resetting wallet state and its sessions. Reading the config here (rather than at
 * module scope) keeps missing-env failures inside the render tree, where the ErrorBoundary explains them - and
 * keeps this module side-effect-free to import.
 *
 * @returns The shared WalletManager instance.
 */
export function getWalletManager(): WalletManager {
  if (cachedManager === undefined) {
    let supportedWallets: WalletAdapterConfig[]
    if (import.meta.env.VITE_ALGOD_NETWORK === 'localnet') {
      const kmdConfig = getKmdConfigFromViteEnvironment()
      supportedWallets = [
        kmd({
          baseServer: kmdConfig.server,
          token: typeof kmdConfig.token === 'string' ? kmdConfig.token : JSON.stringify(kmdConfig.token),
          port: String(kmdConfig.port),
          wallet: kmdConfig.wallet,
          // Invoked by the KMD adapter on real connects only; unit tests never reach a KMD daemon.
          /* v8 ignore next */
          promptForPassword: () => Promise.resolve(kmdConfig.password),
        }),
      ]
    } else {
      supportedWallets = [
        defly(),
        pera(),
        exodus(),
        // If you are interested in WalletConnect v2 provider
        // refer to https://github.com/TxnLab/use-wallet for detailed integration instructions
      ]
    }
    const algodConfig = getAlgodConfigFromViteEnvironment()
    cachedManager = new WalletManager({
      wallets: supportedWallets,
      defaultNetwork: algodConfig.network,
      networks: {
        [algodConfig.network]: {
          algod: {
            baseServer: algodConfig.server,
            port: algodConfig.port,
            token: typeof algodConfig.token === 'string' ? algodConfig.token : JSON.stringify(algodConfig.token),
          },
        },
      },
    })
  }
  return cachedManager
}
