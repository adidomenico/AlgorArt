import { useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import type { CampaignViewModel } from '../../lib/campaign'
import { fetchMyPledge, listCampaigns } from '../../lib/campaign'
import CampaignCard from './CampaignCard'

interface CampaignListProps {
  /** Set when the user opens a specific campaign (state-based navigation). */
  onSelectCampaign: (id: bigint) => void
}

const CampaignList = ({ onSelectCampaign }: CampaignListProps) => {
  const { activeAddress } = useWallet()
  const [campaigns, setCampaigns] = useState<CampaignViewModel[]>([])
  const [nowSeconds, setNowSeconds] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    // Fast pass without the viewer: cards render from global state alone (~0.2s for the whole list).
    // Pledge totals need a full history replay each, so they stream in afterwards without blocking.
    listCampaigns()
      .then((result) => {
        if (!cancelled) {
          setNowSeconds(result.nowSeconds)
          setCampaigns(result.campaigns)
          if (activeAddress) {
            const viewer = activeAddress
            void Promise.all(
              result.campaigns.map(async (campaign) => {
                const total = await fetchMyPledge(campaign.id, viewer).catch(() => undefined)
                if (!cancelled && total !== undefined) {
                  setCampaigns((previous) =>
                    previous.map((existing) => (existing.id === campaign.id ? { ...existing, myPledgeMicroAlgos: total } : existing)),
                  )
                }
              }),
            )
          }
        }
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load campaigns. Is the indexer reachable?')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeAddress])

  if (loading) {
    return (
      <div>
        <p className="text-muted">Loading campaigns…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div>
        <p className="text-badge-failed">{error}</p>
      </div>
    )
  }

  // A finished load with no error always sets the timestamp: reaching here with null means a logic bug.
  /* v8 ignore next */
  if (nowSeconds === null) {
    return (
      <div>
        <p className="text-muted">Loading campaigns…</p>
      </div>
    )
  }

  if (campaigns.length === 0) {
    return (
      <div>
        <p className="text-muted">No campaigns yet. Create the first one!</p>
      </div>
    )
  }

  return (
    <div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
        {campaigns.map((campaign) => (
          <CampaignCard key={campaign.id.toString()} campaign={campaign} nowSeconds={nowSeconds} onSelect={onSelectCampaign} />
        ))}
      </div>
    </div>
  )
}

export default CampaignList
