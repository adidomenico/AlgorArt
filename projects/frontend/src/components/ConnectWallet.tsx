import type { Wallet } from '@txnlab/use-wallet-react'
import { useWallet, WalletId } from '@txnlab/use-wallet-react'
import Account from './Account'

interface ConnectWalletInterface {
  openModal: boolean
  closeModal: () => void
}

const ConnectWallet = ({ openModal, closeModal }: ConnectWalletInterface) => {
  const { wallets, activeAddress } = useWallet()

  const isKmd = (wallet: Wallet) => wallet.id === WalletId.KMD

  return (
    <dialog
      id="connect_wallet_modal"
      className={`fixed inset-0 z-[9999] overflow-auto bg-black/60 ${openModal ? 'block' : 'hidden'}`}
      style={{ display: openModal ? 'block' : 'none' }}
    >
      <form method="dialog" className="mx-auto w-[26em] max-w-[90vw] rounded-lg bg-white p-6">
        <h3 className="font-bold text-2xl">Select wallet provider</h3>

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
                className="m-2 flex cursor-pointer items-center justify-center gap-2 rounded-md border border-teal-dark bg-card px-4 py-2 text-sm text-ink hover:border-teal disabled:cursor-not-allowed disabled:opacity-50"
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
          <button
            type="button"
            data-test-id="close-wallet-modal"
            className="cursor-pointer rounded-md border border-line bg-card px-4 py-2 text-sm text-ink hover:border-teal disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => {
              closeModal()
            }}
          >
            Close
          </button>
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
