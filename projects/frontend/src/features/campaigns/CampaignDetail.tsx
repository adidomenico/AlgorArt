import { useWallet } from '@txnlab/use-wallet-react'
import { useCallback, useEffect, useState } from 'react'
import type { CampaignViewModel } from '../../lib/campaign'
import { getCampaign } from '../../lib/campaign'
import { formatAlgo, formatCountdown, formatDeadline } from '../../lib/format'
import type { BackerLeaf } from '../../lib/transaction'
import { cancelPledge, claim, deleteCampaign, fetchMyLeaves, fetchVaultBox, fetchVaultConfig, refund } from '../../lib/transaction'
import PledgeForm from './PledgeForm'

interface CampaignDetailProps {
  appId: bigint
  onBack: () => void
}

interface WindowInfo {
  /** Refund window ends at this UNIX timestamp (seconds). */
  endsAt: bigint
  /** Where unclaimed residuals go after the window. */
  sweepTarget: string
}

const NETWORK_FEE_ALGO = '≈0.004 ALGO'
const CLAIM_FEE_ALGO = '≈0.003 ALGO'

const CampaignDetail = ({ appId, onBack }: CampaignDetailProps) => {
  const { activeAddress, activeWallet, transactionSigner } = useWallet()
  const [campaign, setCampaign] = useState<CampaignViewModel | null>(null)
  const [leaves, setLeaves] = useState<BackerLeaf[]>([])
  const [windowInfo, setWindowInfo] = useState<WindowInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
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
      if (activeAddress) {
        try {
          setLeaves(await fetchMyLeaves(appId, activeAddress))
        } catch {
          setLeaves([])
        }
      } else {
        setLeaves([])
      }
      // Refund-window banner data (failed campaigns only): fresh vault box + configured window.
      const box = await fetchVaultBox(appId).catch(() => undefined)
      if (box !== undefined && box.status === 2 && box.settledAt > 0n) {
        const config = await fetchVaultConfig().catch(() => undefined)
        if (config !== undefined) {
          setWindowInfo({ endsAt: box.settledAt + config.window, sweepTarget: config.sweepTarget })
        } else {
          setWindowInfo(null)
        }
      } else {
        setWindowInfo(null)
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
  const hasPledge = leaves.length > 0
  const canPledge = campaign.status === 'open' && connected && !isCreator
  const canClaim = campaign.status === 'funded' && isCreator
  const canRefund = campaign.status === 'failed' && connected && hasPledge
  const canCancelPledge = campaign.status === 'open' && connected && hasPledge
  const canDelete = isCreator && (campaign.status !== 'open' || campaign.raisedMicroAlgos === 0n)

  const runAction = async (key: string, action: () => Promise<void>, success: string) => {
    setBusy(true)
    setBusyAction(key)
    setMessage(null)
    try {
      await action()
      setMessage(success)
      await load()
    } catch {
      setMessage('Transaction failed. Another pledge or refund may have landed first — please try again.')
    } finally {
      setBusy(false)
      setBusyAction(null)
    }
  }

  const sessionOf = () => {
    if (!activeAddress) throw new Error('no wallet')
    return { address: activeAddress, signer: transactionSigner }
  }

  const handleClaim = () => {
    void runAction('claim', () => claim(appId, sessionOf()), 'Claim submitted!')
  }

  const handleDelete = () => {
    void runAction('delete', () => deleteCampaign(appId, sessionOf()), 'Campaign deleted!')
  }

  const handleSpend = (leaf: BackerLeaf, kind: 'cancel' | 'refund') => {
    const key = `${kind}-${leaf.position.toString()}`
    const action = kind === 'cancel' ? () => cancelPledge(appId, sessionOf(), leaf) : () => refund(appId, sessionOf(), leaf)
    void runAction(key, action, kind === 'cancel' ? 'Pledge withdrawn!' : 'Refund submitted!')
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

        {campaign.status === 'failed' && windowInfo && (
          <p className="detail__banner">
            Refunds are open until {formatDeadline(windowInfo.endsAt)}. After that, unclaimed funds go to {windowInfo.sweepTarget}. Each
            refund is one pledge at a time.
          </p>
        )}

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
              {busy && busyAction === 'claim' ? 'Claiming…' : 'Claim funds'}
            </button>
            <p className="detail__fee">Network fee {CLAIM_FEE_ALGO}. No backer action needed after success.</p>
          </div>
        )}

        {canCancelPledge && (
          <div className="detail__actions">
            <h3 className="detail__subtitle">Your pledges</h3>
            {leaves.map((leaf) => (
              <div key={leaf.position} className="detail__leaf">
                <span>
                  Pledge #{leaf.position.toString()}: {formatAlgo(leaf.amount)} ALGO
                </span>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    handleSpend(leaf, 'cancel')
                  }}
                >
                  {busy && busyAction === `cancel-${leaf.position.toString()}` ? 'Withdrawing…' : 'Cancel pledge'}
                </button>
              </div>
            ))}
            <p className="detail__fee">Network fee {NETWORK_FEE_ALGO} per cancellation.</p>
          </div>
        )}

        {canRefund && (
          <div className="detail__actions">
            <h3 className="detail__subtitle">Your pledges</h3>
            {leaves.map((leaf) => (
              <div key={leaf.position} className="detail__leaf">
                <span>
                  Pledge #{leaf.position.toString()}: {formatAlgo(leaf.amount)} ALGO
                </span>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => {
                    handleSpend(leaf, 'refund')
                  }}
                >
                  {busy && busyAction === `refund-${leaf.position.toString()}` ? 'Refunding…' : 'Refund my pledge'}
                </button>
              </div>
            ))}
            <p className="detail__fee">Network fee {NETWORK_FEE_ALGO} per refund.</p>
          </div>
        )}

        {canDelete && (
          <div className="detail__actions">
            <button type="button" className="btn btn--danger" disabled={busy} onClick={handleDelete}>
              {busy && busyAction === 'delete' ? 'Deleting…' : 'Delete campaign'}
            </button>
            <p className="detail__fee">Network fee {CLAIM_FEE_ALGO}.</p>
          </div>
        )}

        {message && <p className="detail__message">{message}</p>}
      </div>
    </div>
  )
}

export default CampaignDetail
