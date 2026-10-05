import { useWallet } from '@txnlab/use-wallet-react'
import { useState } from 'react'
import ConnectWallet from '../../components/ConnectWallet'
import { ellipseAddress } from '../../utils/ellipseAddress'

interface NavProps {
  onNavigateHome: () => void
}

const Nav = ({ onNavigateHome }: NavProps) => {
  const { activeAddress } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)

  return (
    <nav className="flex items-center justify-between border-b border-line bg-card px-6 py-3">
      <button type="button" className="cursor-pointer border-0 bg-transparent text-xl font-bold text-teal-dark" onClick={onNavigateHome}>
        AlgorArt
      </button>

      <div className="flex items-center gap-3">
        {activeAddress && <span className="text-sm text-muted">{ellipseAddress(activeAddress)}</span>}
        <button
          type="button"
          className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => {
            setWalletOpen((open) => !open)
          }}
        >
          {activeAddress ? 'Account' : 'Connect wallet'}
        </button>
      </div>

      <ConnectWallet openModal={walletOpen} />
    </nav>
  )
}

export default Nav
