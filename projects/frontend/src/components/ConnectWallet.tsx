import type { Wallet } from '@txnlab/use-wallet-react'
import { useWallet, WalletId } from '@txnlab/use-wallet-react'
import Account from './Account'

interface ConnectWalletInterface {
  openModal: boolean
}

const ConnectWallet = ({ openModal }: ConnectWalletInterface) => {
  const { wallets, activeAddress } = useWallet()

  const isKmd = (wallet: Wallet) => wallet.id === WalletId.KMD

  return (
    <dialog
      id="connect_wallet_modal"
      className={`fixed right-6 top-16 left-auto z-[9999] m-0 w-[22em] max-w-[calc(100vw-2rem)] border-0 bg-transparent p-0 ${openModal ? 'block' : 'hidden'}`}
      style={{ display: openModal ? 'block' : 'none' }}
    >
      <form method="dialog" className="w-full rounded-lg border border-line bg-white p-6">
        <h3 className="font-bold text-2xl">{activeAddress ? 'Account' : 'Select wallet provider'}</h3>

        <div className="grid m-2 gap-2 pt-5">
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
                onClick={() => {
                  void wallet.connect()
                }}
              >
                {!isKmd(wallet) && (
                  <img alt={`wallet_icon_${wallet.id}`} src={wallet.metadata.icon} className="h-auto w-[30px] object-contain" />
                )}
                <span>{isKmd(wallet) ? 'LocalNet Wallet' : wallet.metadata.name}</span>
              </button>
            ))}
        </div>

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
                    localStorage.removeItem('@txnlab/use-wallet:v3')
                    window.location.reload()
                  }
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
