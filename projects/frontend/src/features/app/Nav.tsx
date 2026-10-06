import { useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useRef, useState } from 'react'
import ConnectWallet from '../../components/ConnectWallet'
import { ellipseAddress } from '../../utils/ellipseAddress'

interface NavProps {
  onNavigateHome: () => void
}

const Nav = ({ onNavigateHome }: NavProps) => {
  const { activeAddress } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)
  const navRef = useRef<HTMLElement>(null)
  const prevActiveAddress = useRef(activeAddress)

  // Close the banner on a fresh connect; reopening it while connected shows the account view.
  useEffect(() => {
    if (prevActiveAddress.current !== activeAddress) {
      prevActiveAddress.current = activeAddress
      if (activeAddress) setWalletOpen(false)
    }
  }, [activeAddress])

  // The banner is a dropdown: any pointer-down outside the nav closes it.
  useEffect(() => {
    if (!walletOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(event.target as Node)) setWalletOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [walletOpen])

  return (
    <nav ref={navRef} className="flex items-center justify-between border-b border-line bg-card px-6 py-3">
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
