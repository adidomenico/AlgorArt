import { useWallet } from '@txnlab/use-wallet-react'
import { useCallback, useEffect, useState } from 'react'
import Footer from './features/app/Footer'
import Nav from './features/app/Nav'
import Profile from './features/app/Profile'
import Settings from './features/app/Settings'
import CampaignDetail from './features/campaigns/CampaignDetail'
import CampaignList from './features/campaigns/CampaignList'
import CreateCampaignForm from './features/campaigns/CreateCampaignForm'

type View =
  | { kind: 'list' }
  | { kind: 'detail'; appId: bigint }
  | { kind: 'create' }
  | { kind: 'profile' }
  | { kind: 'pledges' }
  | { kind: 'projects' }
  | { kind: 'settings' }

const Home = () => {
  const [view, setView] = useState<View>({ kind: 'list' })
  const { activeAddress } = useWallet()

  const navigate = useCallback((next: View) => {
    window.history.pushState(next, '')
    setView(next)
  }, [])

  const goBack = useCallback(() => {
    window.history.back()
  }, [])

  const navigateHome = useCallback(() => navigate({ kind: 'list' }), [navigate])
  const navigateProfile = useCallback(() => navigate({ kind: 'profile' }), [navigate])
  const navigatePledges = useCallback(() => navigate({ kind: 'pledges' }), [navigate])
  const navigateProjects = useCallback(() => navigate({ kind: 'projects' }), [navigate])
  const navigateSettings = useCallback(() => navigate({ kind: 'settings' }), [navigate])

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      setView((event.state as View | null) ?? { kind: 'list' })
    }

    window.addEventListener('popstate', handlePopState)
    return () => {
      window.removeEventListener('popstate', handlePopState)
    }
  }, [])

  return (
    <div className="flex min-h-screen flex-col">
      <Nav
        onNavigateHome={navigateHome}
        onNavigateProfile={navigateProfile}
        onNavigatePledges={navigatePledges}
        onNavigateProjects={navigateProjects}
        onNavigateSettings={navigateSettings}
      />

      <main className="mx-auto w-full max-w-4xl flex-1 p-6">
        {view.kind === 'list' && (
          <>
            <div className="mb-6 flex items-center justify-between">
              <h1 className="m-0 text-[1.75rem]">Campaigns</h1>
              <button
                type="button"
                className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!activeAddress}
                title={!activeAddress ? 'Connect your wallet to create a campaign' : undefined}
                onClick={() => {
                  navigate({ kind: 'create' })
                }}
              >
                + New campaign
              </button>
            </div>
            {!activeAddress && <p className="mb-6 text-sm text-muted">Connect your wallet to create a campaign.</p>}
            <CampaignList
              onSelectCampaign={(appId) => {
                navigate({ kind: 'detail', appId })
              }}
            />
          </>
        )}

        {view.kind === 'detail' && (
          <CampaignDetail
            appId={view.appId}
            onBack={() => {
              navigate({ kind: 'list' })
            }}
          />
        )}

        {view.kind === 'create' && (
          <CreateCampaignForm
            onCreated={(appId) => {
              navigate({ kind: 'detail', appId })
            }}
            onCancel={() => {
              goBack()
            }}
          />
        )}

        {view.kind === 'profile' && <Profile onBack={() => navigate({ kind: 'list' })} />}

        {view.kind === 'pledges' && (
          <div className="max-w-md mx-auto text-center py-12">
            <h1 className="text-2xl font-bold mb-4">My Pledges</h1>
            <p className="text-muted mb-6">Coming soon — will show your live pledge leaves from the campaign trees.</p>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark"
              onClick={() => navigate({ kind: 'list' })}
            >
              Back
            </button>
          </div>
        )}

        {view.kind === 'projects' && (
          <div className="max-w-md mx-auto text-center py-12">
            <h1 className="text-2xl font-bold mb-4">My Projects</h1>
            <p className="text-muted mb-6">Coming soon — will show campaigns you created.</p>
            <button
              type="button"
              className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark"
              onClick={() => navigate({ kind: 'list' })}
            >
              Back
            </button>
          </div>
        )}

        {view.kind === 'settings' && <Settings onBack={() => navigate({ kind: 'list' })} />}
      </main>

      <Footer />
    </div>
  )
}

export default Home
