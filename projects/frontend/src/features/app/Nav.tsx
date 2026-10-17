import { useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useRef, useState } from 'react'
import ConnectWallet from '../../components/ConnectWallet'
import { ensureLiveSessionFor } from '../../lib/session'
import { getWalletManager } from '../../lib/wallets'
import { ellipseAddress } from '../../utils/ellipseAddress'

interface NavProps {
  onNavigateHome: () => void
  onNavigateProfile: () => void
  onNavigatePledges: () => void
  onNavigateProjects: () => void
  onNavigateSettings: () => void
}

const Nav = ({ onNavigateHome, onNavigateProfile, onNavigatePledges, onNavigateProjects, onNavigateSettings }: NavProps) => {
  const { activeAddress, activeWallet } = useWallet()
  const [walletOpen, setWalletOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const prevActiveAddress = useRef(activeAddress)

  // Revalidate the wallet bridge when the tab becomes visible again: a silently dead bridge keeps
  // activeAddress set, so without this the nav looks connected until the next failed send.
  useEffect(() => {
    const revalidate = () => {
      if (document.visibilityState !== 'visible') return
      // A dead bridge clears the store via onDisconnect - the nav flips on the next render.
      void ensureLiveSessionFor(getWalletManager(), activeWallet).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', revalidate)
    return () => {
      document.removeEventListener('visibilitychange', revalidate)
    }
  }, [activeWallet])

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

  // Hamburger menu: any pointer-down outside the menu closes it.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [menuOpen])

  return (
    <nav ref={navRef} className="flex items-center justify-between border-b border-line bg-card px-6 py-3">
      <button type="button" className="cursor-pointer border-0 bg-transparent text-xl font-bold text-teal-dark" onClick={onNavigateHome}>
        kasakame
      </button>

      <div className="flex items-center gap-3">
        {activeAddress && <span className="text-sm text-muted">{ellipseAddress(activeAddress)}</span>}

        {activeAddress && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark"
              onClick={() => {
                setMenuOpen((open) => !open)
              }}
            >
              Menu
            </button>
            {menuOpen && (
              <div className="absolute right-0 z-10 mt-2 w-48 rounded-md border border-line bg-card py-1 shadow-lg">
                <button
                  type="button"
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted/50"
                  onClick={() => {
                    setMenuOpen(false)
                    onNavigateProfile()
                  }}
                >
                  Profile
                </button>
                <button
                  type="button"
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted/50"
                  onClick={() => {
                    setMenuOpen(false)
                    onNavigatePledges()
                  }}
                >
                  My Pledges
                </button>
                <button
                  type="button"
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted/50"
                  onClick={() => {
                    setMenuOpen(false)
                    onNavigateProjects()
                  }}
                >
                  My Projects
                </button>
                <button
                  type="button"
                  className="w-full px-4 py-2 text-left text-sm hover:bg-muted/50"
                  onClick={() => {
                    setMenuOpen(false)
                    onNavigateSettings()
                  }}
                >
                  Settings
                </button>
              </div>
            )}
          </div>
        )}

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

      <ConnectWallet
        openModal={walletOpen}
        onHide={() => {
          setWalletOpen(false)
        }}
        onShow={() => {
          setWalletOpen(true)
        }}
      />
    </nav>
  )
}

export default Nav
