import { useWallet } from '@txnlab/use-wallet-react'
import { useCallback, useEffect, useState } from 'react'
import type { CampaignViewModel } from '../../lib/campaign'
import { getCampaign } from '../../lib/campaign'
import { formatAlgo, formatCountdown, formatDeadline } from '../../lib/format'
import { claim, refund } from '../../lib/transaction'
import PledgeForm from './PledgeForm'

interface CampaignDetailProps {
  appId: bigint
  onBack: () => void
}

const CampaignDetail = ({ appId, onBack }: CampaignDetailProps) => {
  const { activeAddress, activeWallet, transactionSigner } = useWallet()
  const [campaign, setCampaign] = useState<CampaignViewModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await getCampaign(appId, BigInt(Math.floor(Date.now() / 1000)), activeAddress ?? undefined)
      if (!result) {
        setError('Campaign not found (or it is not a Campaign app).')
      } else {
        setCampaign(result)
      }
    } catch {
      setError('Failed to load campaign. Is the indexer reachable?')
    } finally {
      setLoading(false)
    }
  }, [appId, activeAddress])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) return <p className="detail__status">Loading campaign…</p>
  if (error) return <p className="detail__status detail__status--error">{error}</p>
  if (!campaign) return null

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000))
  const percent = campaign.goalMicroAlgos > 0n ? Number((campaign.raisedMicroAlgos * 100n) / campaign.goalMicroAlgos) : 0
  const connected = Boolean(activeWallet && activeAddress)
  const isCreator = connected && campaign.creator !== '' && activeAddress === campaign.creator
  const hasPledge = (campaign.myPledgeMicroAlgos ?? 0n) > 0n
  const canPledge = campaign.status === 'open' && connected && !isCreator
  const canClaim = campaign.status === 'funded' && isCreator
  const canRefund = campaign.status === 'failed' && connected && hasPledge

  const runAction = async (action: () => Promise<void>, success: string) => {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      setMessage(success)
      await load()
    } catch {
      setMessage('Transaction failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const handleClaim = () => {
    if (!activeAddress) return
    void runAction(() => claim(appId, { address: activeAddress, signer: transactionSigner }), 'Claim submitted!')
  }

  const handleRefund = () => {
    if (!activeAddress) return
    void runAction(() => refund(appId, { address: activeAddress, signer: transactionSigner }), 'Refund submitted!')
  }

  return (
    <div className="detail">
      <button type="button" className="btn btn--link" onClick={onBack}>
        ← Back to campaigns
      </button>

      <div className="detail__card">
        <div className="detail__header">
          <h2 className="detail__title">{campaign.title || `Campaign #${campaign.id.toString()}`}</h2>
          <span className={`campaign-card__badge campaign-card__badge--${campaign.status}`}>{campaign.status}</span>
        </div>

        <div className="detail__creator">
          Created by {campaign.creator}
          {campaign.metadataUri !== '' && <span className="detail__metadata-uri"> · {campaign.metadataUri}</span>}
        </div>

        <div className="detail__progress">
          <div className="detail__progress-fill" style={{ width: `${String(Math.min(percent, 100))}%` }} />
        </div>
        <p className="detail__raised">
          {formatAlgo(campaign.raisedMicroAlgos)} ALGO raised of {formatAlgo(campaign.goalMicroAlgos)} ALGO goal
        </p>

        <dl className="detail__stats">
          <div>
            <dt>Deadline</dt>
            <dd>{formatDeadline(campaign.deadlineSeconds)}</dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd>{formatCountdown(campaign.deadlineSeconds, nowSeconds)}</dd>
          </div>
          <div>
            <dt>Your pledge</dt>
            <dd>{campaign.myPledgeMicroAlgos !== undefined ? `${formatAlgo(campaign.myPledgeMicroAlgos)} ALGO` : '—'}</dd>
          </div>
        </dl>

        {canPledge && <PledgeForm appId={campaign.id} onPledged={() => void load()} />}

        {canClaim && (
          <div className="detail__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => {
                handleClaim()
              }}
            >
              {busy ? 'Claiming…' : 'Claim funds'}
            </button>
          </div>
        )}

        {canRefund && (
          <div className="detail__actions">
            <button type="button" className="btn btn--primary" disabled={busy} onClick={handleRefund}>
              {busy ? 'Refunding…' : 'Refund my pledge'}
            </button>
          </div>
        )}

        {message && <p className="detail__message">{message}</p>}
      </div>
    </div>
  )
}

export default CampaignDetail
