import { useWallet } from '@txnlab/use-wallet-react'
import { useCallback, useEffect, useState } from 'react'
import { fetchChainTimestamp } from '../../lib/algorand'
import type { CampaignViewModel } from '../../lib/campaign'
import { getCachedCampaigns, getCampaign } from '../../lib/campaign'
import { classifyError, errorMessage } from '../../lib/errors'
import { formatAlgo, formatCountdown, formatDeadline } from '../../lib/format'
import { logError } from '../../lib/log'
import type { BackerLeaf } from '../../lib/transaction'
import {
  cancelPledge,
  claim,
  deleteCampaign,
  disconnectQuietly,
  fetchMyLeaves,
  fetchVaultBox,
  fetchVaultConfig,
  refund,
} from '../../lib/transaction'
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

  const readCore = useCallback(async () => {
    const now = await fetchChainTimestamp()
    const result = await getCampaign(appId, now, activeAddress ?? undefined)
    return { now, result }
  }, [appId, activeAddress])

  const readLeaves = useCallback(async (): Promise<BackerLeaf[]> => {
    if (!activeAddress) return []
    try {
      return await fetchMyLeaves(appId, activeAddress)
    } catch {
      return []
    }
  }, [appId, activeAddress])

  const readWindow = useCallback(async () => {
    const box = await fetchVaultBox(appId).catch(() => undefined)
    if (box === undefined || box.status !== 2 || box.settledAt <= 0n) return null
    const config = await fetchVaultConfig().catch(() => undefined)
    if (config === undefined) return null
    return { endsAt: box.settledAt + config.window, sweepTarget: config.sweepTarget }
  }, [appId])

  // Full initial load with a spinner. Later refreshes use refreshSpend so the page never flashes.
  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [{ now, result }, leaves, window] = await Promise.all([readCore(), readLeaves(), readWindow()])
      setNowSeconds(now)
      if (!result) {
        setError('Campaign not found (or it is not a Campaign app).')
      } else {
        setCampaign(result)
      }
      setLeaves(leaves)
      setWindowInfo(window)
    } catch {
      setError('Failed to load campaign. Is the indexer reachable?')
    } finally {
      setLoading(false)
    }
  }, [readCore, readLeaves, readWindow])

  // Post-action refresh: raised, status, and leaves only. Metadata, window, and timestamp cannot change under an
  // action, so they are left alone - and the old UI stays visible throughout (no spinner).
  const refreshSpend = useCallback(async () => {
    try {
      const [{ now, result }, leaves] = await Promise.all([readCore(), readLeaves()])
      setNowSeconds(now)
      if (result) setCampaign(result)
      setLeaves(leaves)
    } catch {
      setMessage('Could not refresh data. It will update on your next action.')
    }
  }, [readCore, readLeaves])

  const noRefresh = useCallback(() => Promise.resolve(), [])

  // Window banner reload (background only): readWindow never throws, so no error branch.
  const refreshWindow = useCallback(async () => {
    setWindowInfo(await readWindow())
  }, [readWindow])

  useEffect(() => {
    const cached = getCachedCampaigns()
    const prefill = cached?.campaigns.find((c) => c.id === appId)
    if (cached && prefill) {
      // Instant paint from the list's data, then background refresh (no spinner).
      setCampaign(prefill)
      setNowSeconds(cached.nowSeconds)
      setLoading(false)
      void Promise.all([refreshSpend(), refreshWindow()])
    } else {
      void loadAll()
    }
  }, [appId, loadAll, refreshSpend, refreshWindow])

  const metadata = useCampaignMetadata(campaign?.metadataUri ?? '')

  if (loading) {
    return (
      <div>
        <p className="text-muted">Loading campaign…</p>
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
        <p className="text-muted">Loading campaign…</p>
      </div>
    )
  }
  // loadAll() sets either campaign or error, so a null campaign here is unreachable.
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

  const runAction = async (key: string, action: () => Promise<void>, success: string, refresh: () => Promise<unknown>) => {
    setBusy(true)
    setBusyAction(key)
    setMessage(null)
    try {
      await action()
      setMessage(success)
      await refresh()
    } catch (error) {
      logError('transaction', error)
      const kind = classifyError(error)
      if (kind === 'session') {
        // Every action button here requires a connected wallet, so activeWallet is always set - and
        // disconnectQuietly tolerates null anyway.
        void disconnectQuietly(activeWallet)
        setMessage('Wallet session expired. Connect your wallet again to continue.')
      } else {
        setMessage(errorMessage(kind, 'transaction'))
      }
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
    void runAction('claim', () => claim(appId, sessionOf()), 'Claim submitted!', refreshSpend)
  }

  const handleDelete = () => {
    void runAction('delete', () => deleteCampaign(appId, sessionOf()), 'Campaign deleted!', noRefresh).then(() => {
      onBack()
    })
  }

  const handleSpend = (leaf: BackerLeaf, kind: 'cancel' | 'refund') => {
    const key = `${kind}-${leaf.position.toString()}`
    const action = kind === 'cancel' ? () => cancelPledge(appId, sessionOf(), leaf) : () => refund(appId, sessionOf(), leaf)
    void runAction(key, action, kind === 'cancel' ? 'Pledge withdrawn!' : 'Refund submitted!', refreshSpend)
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
          {message && <p className="mt-3 mb-0 text-sm text-muted">{message}</p>}
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
            className={`rounded-full px-2 py-0.5 text-[0.6875rem] font-bold tracking-wider text-white uppercase ${badgeBg[campaign.status]}`}
          >
            {campaign.status}
          </span>
        </div>
        <p className="text-sm text-muted">App id {campaign.id.toString()}</p>

        <div className="mb-4 text-sm break-all text-muted">
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
            <dt className="text-xs tracking-[0.03em] text-muted uppercase">Deadline</dt>
            <dd className="m-0 text-sm font-semibold">{formatDeadline(campaign.deadlineSeconds)}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-[0.03em] text-muted uppercase">Time left</dt>
            <dd className="m-0 text-sm font-semibold">{formatCountdown(campaign.deadlineSeconds, nowSeconds)}</dd>
          </div>
          <div>
            <dt className="text-xs tracking-[0.03em] text-muted uppercase">Your pledge</dt>
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

        {canPledge && <PledgeForm appId={campaign.id} onPledged={() => void refreshSpend()} />}

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

        {message && <p className="mt-3 mb-0 text-sm text-muted">{message}</p>}
      </div>
    </div>
  )
}

export default CampaignDetail
