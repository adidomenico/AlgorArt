import { WalletProvider } from '@txnlab/use-wallet-react'
import { SnackbarProvider } from 'notistack'
import Home from './Home'
import { getWalletManager } from './lib/wallets'

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
