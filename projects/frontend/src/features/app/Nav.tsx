import { useState } from 'react'
import { useWallet } from '@txnlab/use-wallet-react'
import { ellipseAddress } from '../../utils/ellipseAddress'
import ConnectWallet from '../../components/ConnectWallet'

interface NavProps {
  onNavigateHome: () => void
}

const Nav = ({ onNavigateHome }: NavProps) => {
  const { activeAddress } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)

  return (
    <nav className="nav">
      <button type="button" className="nav__brand" onClick={onNavigateHome}>
        AlgorArt
      </button>

      <div className="nav__actions">
        {activeAddress && <span className="nav__address">{ellipseAddress(activeAddress)}</span>}
        <button type="button" className="btn" onClick={() => setWalletOpen(true)}>
          {activeAddress ? 'Account' : 'Connect wallet'}
        </button>
      </div>

      <ConnectWallet openModal={walletOpen} closeModal={() => setWalletOpen(false)} />
    </nav>
  )
}

export default Nav
