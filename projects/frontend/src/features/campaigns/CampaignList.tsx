import { useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import { fetchChainTimestamp } from '../../lib/algorand'
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
  const [nowSeconds, setNowSeconds] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    fetchChainTimestamp()
      .then((now) => {
        if (cancelled) return null
        setNowSeconds(now)
        return listCampaigns(now, activeAddress ?? undefined)
      })
      .then((result) => {
        if (!cancelled && result) setCampaigns(result)
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

  if (loading || nowSeconds === null) {
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
