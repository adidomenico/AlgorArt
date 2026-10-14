import { WALLET_ID as EXODUS_WALLET_ID } from '@txnlab/use-wallet-exodus'
import { WALLET_ID as KMD_WALLET_ID } from '@txnlab/use-wallet-kmd'
import type { Wallet } from '@txnlab/use-wallet-react'
import { useNetwork, useWallet } from '@txnlab/use-wallet-react'
import { useState } from 'react'
import { adaptSignData, backendUrl, clearSession, ensureSession } from '../lib/backend'
import { isDismissalError } from '../lib/errors'
import Account from './Account'

interface ConnectWalletInterface {
  openModal: boolean
  /** Hide the menu when a provider flow starts (their popup takes over). */
  onHide: () => void
  /** Show the menu again when connecting fails, so the error is visible. */
  onShow: () => void
}

const ConnectWallet = ({ openModal, onHide, onShow }: ConnectWalletInterface) => {
  const { wallets, activeAddress, signData } = useWallet()
  const { activeNetworkConfig } = useNetwork()
  const [connectError, setConnectError] = useState<string | null>(null)

  const isKmd = (wallet: Wallet) => wallet.id === KMD_WALLET_ID
  // Only Exodus is extension-gated (window.algorand); Pera/Defly also support mobile flows, so their failures
  // surface through the connect error below instead of a pre-check.
  const isAvailable = (wallet: Wallet) =>
    wallet.id !== EXODUS_WALLET_ID ||
    (typeof window !== 'undefined' && (window as unknown as { algorand?: unknown }).algorand !== undefined)

  const unavailableHint = 'Exodus browser extension not detected - install it to use Exodus'

  return (
    <dialog
      id="connect_wallet_modal"
      className={`fixed top-16 right-6 left-auto z-9999 m-0 w-modal max-w-modal border-0 bg-transparent p-0 ${openModal ? 'block' : 'hidden'}`}
      style={{ display: openModal ? 'block' : 'none' }}
    >
      <form method="dialog" className="w-full rounded-lg border border-line bg-white p-6">
        <h3 className="text-2xl font-bold">{activeAddress ? 'Account' : 'Select wallet provider'}</h3>

        <div className="m-2 grid gap-2 pt-5">
          {activeAddress && (
            <>
              <Account />
              <div className="my-4 border-t border-line" />
            </>
          )}

          {!activeAddress &&
            wallets.map((wallet) => (
              <button
                type="button"
                data-test-id={`${wallet.id}-connect`}
                className="m-2 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
                key={`provider-${wallet.id}`}
                title={!isAvailable(wallet) ? unavailableHint : undefined}
                onClick={() => {
                  void (async () => {
                    setConnectError(null)
                    onHide()
                    try {
                      const accounts = await wallet.connect()
                      const [account] = accounts
                      if (account !== undefined && account.address !== '') {
                        // Pre-warm the backend session so later uploads skip their sign-in popup.
                        // Silent: anything failing here falls back to signing on demand.
                        void ensureSession({
                          baseUrl: backendUrl(),
                          address: account.address,
                          chainId: activeNetworkConfig.caipChainId,
                          sign: adaptSignData(signData),
                          statement: 'Sign in to AlgorArt.',
                          action: 'sign-in',
                        }).catch(() => undefined)
                      }
                    } catch (error) {
                      // Closing the wallet popup is a dismissal, not a failure - reopen the menu quietly.
                      if (!isDismissalError(error)) {
                        setConnectError(
                          wallet.id === EXODUS_WALLET_ID
                            ? `Couldn't connect to ${wallet.metadata.name}. Install the Exodus browser extension, then try again.`
                            : `Couldn't connect to ${wallet.metadata.name}. Check your wallet and try again.`,
                        )
                      }
                      onShow()
                    }
                  })()
                }}
              >
                {!isKmd(wallet) && (
                  <img alt={`wallet_icon_${wallet.id}`} src={wallet.metadata.icon} className="h-auto w-7.5 object-contain" />
                )}
                <span>{isKmd(wallet) ? 'LocalNet Wallet' : wallet.metadata.name}</span>
              </button>
            ))}
        </div>

        {connectError && <p className="mt-3 mb-0 text-sm text-badge-failed">{connectError}</p>}

        <div className="mt-4 grid gap-2">
          {activeAddress && (
            <button
              type="button"
              className="cursor-pointer rounded-md border border-warning bg-warning px-4 py-2 text-sm text-white hover:brightness-90 disabled:cursor-not-allowed disabled:opacity-50"
              data-test-id="logout"
              onClick={() => {
                void (async () => {
                  const activeWallet = wallets.find((w) => w.isActive)
                  if (activeWallet) {
                    await activeWallet.disconnect()
                  } else {
                    // Required for logout/cleanup of inactive providers
                    // For instance, when you login to localnet wallet and switch network
                    // to testnet/mainnet or vice verse.
                    localStorage.removeItem('@txnlab/use-wallet:v5')
                    window.location.reload()
                  }
                  // Drop the backend session too - it belongs to the disconnected address.
                  clearSession()
                })()
              }}
            >
              Logout
            </button>
          )}
        </div>
      </form>
    </dialog>
  )
}
export default ConnectWallet
