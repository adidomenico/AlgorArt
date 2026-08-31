import { useState } from 'react'
import Nav from './features/app/Nav'
import CampaignList from './features/campaigns/CampaignList'
import CampaignDetail from './features/campaigns/CampaignDetail'
import CreateCampaignForm from './features/campaigns/CreateCampaignForm'

type View = { kind: 'list' } | { kind: 'detail'; appId: bigint } | { kind: 'create' }

const Home = () => {
  const [view, setView] = useState<View>({ kind: 'list' })

  return (
    <div className="app">
      <Nav
        onNavigateHome={() => {
          setView({ kind: 'list' })
        }}
      />

      <main className="app__main">
        {view.kind === 'list' && (
          <>
            <div className="app__toolbar">
              <h1 className="app__heading">Campaigns</h1>
              <button type="button" className="btn btn--primary" onClick={() => setView({ kind: 'create' })}>
                + New campaign
              </button>
            </div>
            <CampaignList onSelectCampaign={(appId) => setView({ kind: 'detail', appId })} />
          </>
        )}

        {view.kind === 'detail' && <CampaignDetail appId={view.appId} onBack={() => setView({ kind: 'list' })} />}

        {view.kind === 'create' && (
          <CreateCampaignForm onCreated={(appId) => setView({ kind: 'detail', appId })} onCancel={() => setView({ kind: 'list' })} />
        )}
      </main>
    </div>
  )
}

export default Home
