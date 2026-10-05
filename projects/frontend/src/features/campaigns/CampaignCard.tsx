import type { CampaignViewModel } from '../../lib/campaign'
import { formatAlgo, formatCountdown, formatDeadline } from '../../lib/format'
import CampaignImage from './CampaignImage'

interface CampaignCardProps {
  campaign: CampaignViewModel
  /** Chain timestamp (seconds) for the countdown — never wall-clock (see `fetchChainTimestamp`). */
  nowSeconds: bigint
  onSelect: (id: bigint) => void
}

const badgeBg: Record<CampaignViewModel['status'], string> = {
  open: 'bg-badge-open',
  funded: 'bg-badge-funded',
  failed: 'bg-badge-failed',
  claimed: 'bg-badge-claimed',
}

const CampaignCard = ({ campaign, nowSeconds, onSelect }: CampaignCardProps) => {
  const percent = campaign.goalMicroAlgos > 0n ? Number((campaign.raisedMicroAlgos * 100n) / campaign.goalMicroAlgos) : 0

  return (
    <button
      type="button"
      className="block w-full cursor-pointer rounded-lg border border-line bg-card p-4 text-left font-[inherit] text-ink hover:border-teal"
      onClick={() => {
        onSelect(campaign.id)
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-muted">#{campaign.id.toString()}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.05em] text-white ${badgeBg[campaign.status]}`}
        >
          {campaign.status}
        </span>
      </div>

      <h3 className="m-0 mb-3 text-lg font-semibold text-ink">{campaign.title}</h3>

      <CampaignImage metadataUri={campaign.metadataUri} title={campaign.title} className="mb-3 h-40 w-full rounded-md object-cover" />

      <div className="mb-3 h-2 overflow-hidden rounded-full bg-line">
        <div data-testid="progress-fill" className="h-full bg-teal" style={{ width: `${String(Math.min(percent, 100))}%` }} />
      </div>

      <dl className="m-0 grid grid-cols-2 gap-2">
        <div>
          <dt className="text-xs uppercase tracking-[0.03em] text-muted">Raised</dt>
          <dd className="m-0 text-sm font-semibold">{formatAlgo(campaign.raisedMicroAlgos)} ALGO</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.03em] text-muted">Goal</dt>
          <dd className="m-0 text-sm font-semibold">{formatAlgo(campaign.goalMicroAlgos)} ALGO</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.03em] text-muted">Deadline</dt>
          <dd className="m-0 text-sm font-semibold">{formatDeadline(campaign.deadlineSeconds)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.03em] text-muted">Ends in</dt>
          <dd className="m-0 text-sm font-semibold">{formatCountdown(campaign.deadlineSeconds, nowSeconds)}</dd>
        </div>
      </dl>

      {campaign.myPledgeMicroAlgos !== undefined && campaign.myPledgeMicroAlgos > 0n && (
        <p className="mb-0 mt-3 text-sm font-semibold text-teal-dark">Your pledge: {formatAlgo(campaign.myPledgeMicroAlgos)} ALGO</p>
      )}
    </button>
  )
}

export default CampaignCard
