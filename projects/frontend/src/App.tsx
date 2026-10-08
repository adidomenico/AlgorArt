import type { SupportedWallet } from '@txnlab/use-wallet-react'
import { WalletId, WalletManager, WalletProvider } from '@txnlab/use-wallet-react'
import { SnackbarProvider } from 'notistack'
import Home from './Home'
import { getAlgodConfigFromViteEnvironment, getKmdConfigFromViteEnvironment } from './utils/network/getAlgoClientConfigs'

let supportedWallets: SupportedWallet[]
if (import.meta.env.VITE_ALGOD_NETWORK === 'localnet') {
  const kmdConfig = getKmdConfigFromViteEnvironment()
  supportedWallets = [
    {
      id: WalletId.KMD,
      options: {
        baseServer: kmdConfig.server,
        token: typeof kmdConfig.token === 'string' ? kmdConfig.token : JSON.stringify(kmdConfig.token),
        port: String(kmdConfig.port),
        wallet: kmdConfig.wallet,
        promptForPassword: () => Promise.resolve(kmdConfig.password),
      },
    },
  ]
} else {
  supportedWallets = [
    { id: WalletId.DEFLY },
    { id: WalletId.PERA },
    { id: WalletId.EXODUS },
    // If you are interested in WalletConnect v2 provider
    // refer to https://github.com/TxnLab/use-wallet for detailed integration instructions
  ]
}

/**
 * The shared wallet manager, created once on first render. It must not be constructed during render: every render
 * would create a fresh manager, resetting wallet state and its sessions. Reading the config here (rather than at
 * module scope) keeps missing-env failures inside the render tree, where the ErrorBoundary explains them.
 *
 * @returns The shared WalletManager instance.
 */
function getWalletManager(): WalletManager {
  if (cachedManager === undefined) {
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
      options: {
        resetNetwork: true,
      },
    })
  }
  return cachedManager
}

let cachedManager: WalletManager | undefined

/**
 * Root component: wraps the app in wallet and snackbar providers.
 *
 * @returns The app element tree.
 */
export default function App() {
  return (
    <SnackbarProvider maxSnack={3}>
      <WalletProvider manager={getWalletManager()}>
        <Home />
      </WalletProvider>
    </SnackbarProvider>
  )
}
