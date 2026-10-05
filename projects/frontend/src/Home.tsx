import { useCallback, useEffect, useState } from 'react'
import Footer from './features/app/Footer'
import Nav from './features/app/Nav'
import CampaignDetail from './features/campaigns/CampaignDetail'
import CampaignList from './features/campaigns/CampaignList'
import CreateCampaignForm from './features/campaigns/CreateCampaignForm'

type View = { kind: 'list' } | { kind: 'detail'; appId: bigint } | { kind: 'create' }

const Home = () => {
  const [view, setView] = useState<View>({ kind: 'list' })

  const navigate = useCallback((next: View) => {
    window.history.pushState(next, '')
    setView(next)
  }, [])

  const goBack = useCallback(() => {
    window.history.back()
  }, [])

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
        onNavigateHome={() => {
          navigate({ kind: 'list' })
        }}
      />

      <main className="mx-auto w-full max-w-4xl flex-1 p-6">
        {view.kind === 'list' && (
          <>
            <div className="mb-6 flex items-center justify-between">
              <h1 className="m-0 text-[1.75rem]">Campaigns</h1>
              <button
                type="button"
                className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  navigate({ kind: 'create' })
                }}
              >
                + New campaign
              </button>
            </div>
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
      </main>

      <Footer />
    </div>
  )
}

export default Home
