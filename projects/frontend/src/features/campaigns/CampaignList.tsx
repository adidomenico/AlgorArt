import { useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import type { CampaignViewModel } from '../../lib/campaign'
import { listCampaigns } from '../../lib/campaign'
import CampaignCard from './CampaignCard'

interface CampaignListProps {
  /** Set when the user opens a specific campaign (state-based navigation). */
  onSelectCampaign: (id: bigint) => void
}

const CampaignList = ({ onSelectCampaign }: CampaignListProps) => {
  const { activeAddress } = useWallet()
  const [campaigns, setCampaigns] = useState<CampaignViewModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    listCampaigns(BigInt(Math.floor(Date.now() / 1000)), activeAddress ?? undefined)
      .then((result) => {
        if (!cancelled) setCampaigns(result)
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
      <div className="campaign-list">
        <p className="campaign-list__status">Loading campaigns…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="campaign-list">
        <p className="campaign-list__status campaign-list__status--error">{error}</p>
      </div>
    )
  }

  if (campaigns.length === 0) {
    return (
      <div className="campaign-list">
        <p className="campaign-list__status">No campaigns yet. Create the first one!</p>
      </div>
    )
  }

  return (
    <div className="campaign-list">
      <div className="campaign-list__grid">
        {campaigns.map((campaign) => (
          <CampaignCard key={campaign.id.toString()} campaign={campaign} onSelect={onSelectCampaign} />
        ))}
      </div>
    </div>
  )
}

export default CampaignList
