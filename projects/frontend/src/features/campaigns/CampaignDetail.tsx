import { useWallet } from '@txnlab/use-wallet-react'
import { useCallback, useEffect, useState } from 'react'
import { fetchChainTimestamp } from '../../lib/algorand'
import type { CampaignViewModel } from '../../lib/campaign'
import { getCampaign } from '../../lib/campaign'
import { formatAlgo, formatCountdown, formatDeadline } from '../../lib/format'
import type { BackerLeaf } from '../../lib/transaction'
import { cancelPledge, claim, deleteCampaign, fetchMyLeaves, fetchVaultBox, fetchVaultConfig, refund } from '../../lib/transaction'
import CampaignImage from './CampaignImage'
import PledgeForm from './PledgeForm'
import { useCampaignMetadata } from './useCampaignMetadata'

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
const DELETE_FEE_ALGO = '≈0.005 ALGO'

const badgeBg: Record<CampaignViewModel['status'], string> = {
  open: 'bg-badge-open',
  funded: 'bg-badge-funded',
  failed: 'bg-badge-failed',
  claimed: 'bg-badge-claimed',
}

const CampaignDetail = ({ appId, onBack }: CampaignDetailProps) => {
  const { activeAddress, activeWallet, transactionSigner } = useWallet()
  const [campaign, setCampaign] = useState<CampaignViewModel | null>(null)
  const [nowSeconds, setNowSeconds] = useState<bigint | null>(null)
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
      const now = await fetchChainTimestamp()
      setNowSeconds(now)
      const result = await getCampaign(appId, now, activeAddress ?? undefined)
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

  const metadata = useCampaignMetadata(campaign?.metadataUri ?? '')

  if (loading || nowSeconds === null) return <p className="text-muted">Loading campaign…</p>
  if (error) return <p className="text-badge-failed">{error}</p>
  // load() sets either campaign or error, so a null campaign here is unreachable.
  /* v8 ignore next */
  if (!campaign) return null

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
      setMessage('Transaction failed. Another pledge or refund may have landed first - please try again.')
    } finally {
      setBusy(false)
      setBusyAction(null)
    }
  }

  const sessionOf = () => {
    // Defensive: every caller is gated on `connected`, so this is unreachable in the UI.
    /* v8 ignore next */
    if (!activeAddress) throw new Error('no wallet')
    return { address: activeAddress, signer: transactionSigner }
  }

  const handleClaim = () => {
    void runAction('claim', () => claim(appId, sessionOf()), 'Claim submitted!')
  }

  const handleDelete = () => {
    void runAction('delete', () => deleteCampaign(appId, sessionOf()), 'Campaign deleted!').then(() => {
      onBack()
    })
  }

  const handleSpend = (leaf: BackerLeaf, kind: 'cancel' | 'refund') => {
    const key = `${kind}-${leaf.position.toString()}`
    const action = kind === 'cancel' ? () => cancelPledge(appId, sessionOf(), leaf) : () => refund(appId, sessionOf(), leaf)
    void runAction(key, action, kind === 'cancel' ? 'Pledge withdrawn!' : 'Refund submitted!')
  }

  // Deleted on-chain (global state gone): no actions except vault-direct refunds of live leaves.
  if (campaign.deleted === true) {
    return (
      <div>
        <button
          type="button"
          className="mb-4 cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onBack}
        >
          ← Back to campaigns
        </button>
        <div className="rounded-lg border border-line bg-card p-6">
          <h2 className="m-0 mb-1 text-2xl">Campaign #{campaign.id.toString()} has been deleted</h2>
          <p className="rounded-md border border-line bg-mist p-3 text-sm text-muted">
            Its on-chain state is gone, but the vault still holds live pledges until the refund window closes. Refund below - each refund
            comes straight from the vault.
          </p>
          {leaves.length > 0 && (
            <div className="mt-5 border-t border-line pt-5">
              <h3 className="m-0 mb-3 text-lg">Your pledges</h3>
              {leaves.map((leaf) => (
                <div key={leaf.position} className="flex items-center justify-between gap-2 py-2">
                  <span>
                    Pledge #{leaf.position.toString()}: {formatAlgo(leaf.amount)} ALGO
                  </span>
                  <button
                    type="button"
                    className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy}
                    onClick={() => {
                      handleSpend(leaf, 'refund')
                    }}
                  >
                    {busy && busyAction === `refund-${leaf.position.toString()}` ? 'Refunding…' : 'Refund my pledge'}
                  </button>
                </div>
              ))}
              <p className="text-sm text-muted">Network fee {NETWORK_FEE_ALGO} per refund.</p>
            </div>
          )}
          {message && <p className="mb-0 mt-3 text-sm text-muted">{message}</p>}
        </div>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        className="mb-4 cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onBack}
      >
        ← Back to campaigns
      </button>

      <div className="rounded-lg border border-line bg-card p-6">
        <div className="flex items-center justify-between">
          <h2 className="m-0 mb-1 text-2xl">{campaign.title || `Campaign #${campaign.id.toString()}`}</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-[0.05em] text-white ${badgeBg[campaign.status]}`}
          >
            {campaign.status}
          </span>
        </div>
        <p className="text-sm text-muted">App id {campaign.id.toString()}</p>

        <div className="mb-4 break-all text-sm text-muted">
          Created by {campaign.creator}
          {campaign.metadataUri !== '' && <span className="break-all text-teal-dark"> · {campaign.metadataUri}</span>}
        </div>

        <CampaignImage
          metadataUri={campaign.metadataUri}
          title={campaign.title || `Campaign #${campaign.id.toString()}`}
          className="mb-4 max-h-80 w-full rounded-md object-cover"
        />
        {metadata?.description && <p className="mb-4 text-sm text-muted">{metadata.description}</p>}
        {metadata?.category && <p className="mb-4 text-sm text-muted">Category: {metadata.category}</p>}

        <div className="mb-3 h-2 overflow-hidden rounded-full bg-line">
          <div data-testid="progress-fill" className="h-full bg-teal" style={{ width: `${String(Math.min(percent, 100))}%` }} />
        </div>
        <p className="text-sm text-muted">
          {formatAlgo(campaign.raisedMicroAlgos)} ALGO raised of {formatAlgo(campaign.goalMicroAlgos)} ALGO goal
        </p>

        <dl className="my-4 grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-4">
          <div>
            <dt className="text-xs uppercase tracking-[0.03em] text-muted">Deadline</dt>
            <dd className="m-0 text-sm font-semibold">{formatDeadline(campaign.deadlineSeconds)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.03em] text-muted">Time left</dt>
            <dd className="m-0 text-sm font-semibold">{formatCountdown(campaign.deadlineSeconds, nowSeconds)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-[0.03em] text-muted">Your pledge</dt>
            <dd className="m-0 text-sm font-semibold">
              {campaign.myPledgeMicroAlgos !== undefined ? `${formatAlgo(campaign.myPledgeMicroAlgos)} ALGO` : '-'}
            </dd>
          </div>
        </dl>

        {campaign.status === 'failed' && windowInfo && (
          <p className="rounded-md border border-line bg-mist p-3 text-sm text-muted">
            Refunds are open until {formatDeadline(windowInfo.endsAt)}. After that, unclaimed funds go to {windowInfo.sweepTarget}. Each
            refund is one pledge at a time.
          </p>
        )}

        {canPledge && <PledgeForm appId={campaign.id} onPledged={() => void load()} />}

        {canClaim && (
          <div className="mt-5 border-t border-line pt-5">
            <button
              type="button"
              className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => {
                handleClaim()
              }}
            >
              {busy && busyAction === 'claim' ? 'Claiming…' : 'Claim funds'}
            </button>
            <p className="text-sm text-muted">Network fee {CLAIM_FEE_ALGO}. No backer action needed after success.</p>
          </div>
        )}

        {canCancelPledge && (
          <div className="mt-5 border-t border-line pt-5">
            <h3 className="m-0 mb-3 text-lg">Your pledges</h3>
            {leaves.map((leaf) => (
              <div key={leaf.position} className="flex items-center justify-between gap-2 py-2">
                <span>
                  Pledge #{leaf.position.toString()}: {formatAlgo(leaf.amount)} ALGO
                </span>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    handleSpend(leaf, 'cancel')
                  }}
                >
                  {busy && busyAction === `cancel-${leaf.position.toString()}` ? 'Withdrawing…' : 'Cancel pledge'}
                </button>
              </div>
            ))}
            <p className="text-sm text-muted">Network fee {NETWORK_FEE_ALGO} per cancellation.</p>
          </div>
        )}

        {canRefund && (
          <div className="mt-5 border-t border-line pt-5">
            <h3 className="m-0 mb-3 text-lg">Your pledges</h3>
            {leaves.map((leaf) => (
              <div key={leaf.position} className="flex items-center justify-between gap-2 py-2">
                <span>
                  Pledge #{leaf.position.toString()}: {formatAlgo(leaf.amount)} ALGO
                </span>
                <button
                  type="button"
                  className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy}
                  onClick={() => {
                    handleSpend(leaf, 'refund')
                  }}
                >
                  {busy && busyAction === `refund-${leaf.position.toString()}` ? 'Refunding…' : 'Refund my pledge'}
                </button>
              </div>
            ))}
            <p className="text-sm text-muted">Network fee {NETWORK_FEE_ALGO} per refund.</p>
          </div>
        )}

        {canDelete && (
          <div className="mt-5 border-t border-line pt-5">
            <button
              type="button"
              className="cursor-pointer rounded-md border border-danger bg-danger px-4 py-2 text-sm text-white hover:brightness-90 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={handleDelete}
            >
              {busy && busyAction === 'delete' ? 'Deleting…' : 'Delete campaign'}
            </button>
            <p className="text-sm text-muted">Network fee {DELETE_FEE_ALGO}.</p>
          </div>
        )}

        {message && <p className="mb-0 mt-3 text-sm text-muted">{message}</p>}
      </div>
    </div>
  )
}

export default CampaignDetail
