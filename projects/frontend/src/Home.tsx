import { useCallback, useEffect, useState } from 'react'
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
    <div className="app">
      <Nav
        onNavigateHome={() => {
          navigate({ kind: 'list' })
        }}
      />

      <main className="app__main">
        {view.kind === 'list' && (
          <>
            <div className="app__toolbar">
              <h1 className="app__heading">Campaigns</h1>
              <button
                type="button"
                className="btn btn--primary"
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
    </div>
  )
}

export default Home
