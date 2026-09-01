import type { CampaignViewModel } from '../../lib/campaign'
import { formatAlgo, formatCountdown, formatDeadline } from '../../lib/format'

interface CampaignCardProps {
  campaign: CampaignViewModel
  onSelect: (id: bigint) => void
}

const CampaignCard = ({ campaign, onSelect }: CampaignCardProps) => {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const percent = campaign.goalMicroAlgos > 0n ? Number((campaign.raisedMicroAlgos * 100n) / campaign.goalMicroAlgos) : 0

  return (
    <button
      type="button"
      className="campaign-card"
      onClick={() => {
        onSelect(campaign.id)
      }}
    >
      <div className="campaign-card__header">
        <span className="campaign-card__status">#{campaign.id.toString()}</span>
        <span className={`campaign-card__badge campaign-card__badge--${campaign.status}`}>{campaign.status}</span>
      </div>

      <div className="campaign-card__progress">
        <div className="campaign-card__progress-fill" style={{ width: `${String(Math.min(percent, 100))}%` }} />
      </div>

      <dl className="campaign-card__stats">
        <div>
          <dt>Raised</dt>
          <dd>{formatAlgo(campaign.raisedMicroAlgos)} ALGO</dd>
        </div>
        <div>
          <dt>Goal</dt>
          <dd>{formatAlgo(campaign.goalMicroAlgos)} ALGO</dd>
        </div>
        <div>
          <dt>Deadline</dt>
          <dd>{formatDeadline(campaign.deadlineSeconds)}</dd>
        </div>
        <div>
          <dt>Ends in</dt>
          <dd>{formatCountdown(campaign.deadlineSeconds, nowSeconds)}</dd>
        </div>
      </dl>

      {campaign.myPledgeMicroAlgos !== undefined && campaign.myPledgeMicroAlgos > 0n && (
        <p className="campaign-card__pledge">Your pledge: {formatAlgo(campaign.myPledgeMicroAlgos)} ALGO</p>
      )}
    </button>
  )
}

export default CampaignCard
