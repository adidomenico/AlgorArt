import { useWallet } from '@txnlab/use-wallet-react'
import { useState } from 'react'
import { fetchChainTimestamp } from '../../lib/algorand'
import { parseAlgoToMicroAlgos } from '../../lib/format'
import { createCampaign } from '../../lib/transaction'

interface CreateCampaignFormProps {
  /** Called with the new app id after a successful create. */
  onCreated: (appId: bigint) => void
  onCancel: () => void
}

const CreateCampaignForm = ({ onCreated, onCancel }: CreateCampaignFormProps) => {
  const { activeAddress, transactionSigner } = useWallet()
  const [title, setTitle] = useState('')
  const [metadataUri, setMetadataUri] = useState('')
  const [goal, setGoal] = useState('')
  const [days, setDays] = useState('30')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  // A single bytes global-state value is capped at 128 bytes on the AVM.
  const MAX_BYTES = 128

  const canSubmit = title.trim() !== '' && goal.trim() !== '' && !busy && Boolean(activeAddress && transactionSigner)

  const handleSubmit = async () => {
    // Defensive: the submit button is disabled while disconnected, so this is unreachable in the UI.
    /* v8 ignore next */
    if (!activeAddress) return

    setBusy(true)
    setMessage(null)
    try {
      if (new TextEncoder().encode(title).length > MAX_BYTES) {
        setMessage('Title must be 128 bytes or fewer.')
        return
      }
      if (new TextEncoder().encode(metadataUri).length > MAX_BYTES) {
        setMessage('Metadata URI must be 128 bytes or fewer.')
        return
      }
      const goalMicroAlgos = parseAlgoToMicroAlgos(goal)
      if (goalMicroAlgos <= 0n) {
        setMessage('Goal must be greater than zero.')
        return
      }
      const daysNumber = Number(days)
      if (!Number.isFinite(daysNumber) || daysNumber <= 0) {
        setMessage('Duration must be a positive number of days.')
        return
      }
      const deadlineSeconds = (await fetchChainTimestamp()) + BigInt(Math.floor(daysNumber)) * 86_400n

      const { appId } = await createCampaign(
        { address: activeAddress, signer: transactionSigner },
        title.trim(),
        metadataUri.trim(),
        goalMicroAlgos,
        deadlineSeconds,
      )
      onCreated(appId)
    } catch {
      setMessage('Failed to create campaign. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-5">
      <h3 className="m-0 mb-3 text-lg">Create a campaign</h3>
      <label className="mb-3 block text-sm text-muted">
        Title
        <input
          type="text"
          placeholder="e.g. My first novel"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
          }}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
      </label>
      <label className="mb-3 block text-sm text-muted">
        Metadata URI (optional)
        <input
          type="text"
          placeholder="ipfs://…"
          value={metadataUri}
          onChange={(e) => {
            setMetadataUri(e.target.value)
          }}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
      </label>
      <label className="mb-3 block text-sm text-muted">
        Goal (ALGO)
        <input
          type="number"
          min="0"
          step="any"
          placeholder="e.g. 100"
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value)
          }}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
      </label>
      <label className="mb-3 block text-sm text-muted">
        Duration (days)
        <input
          type="number"
          min="1"
          value={days}
          onChange={(e) => {
            setDays(e.target.value)
          }}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
        >
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      {message && <p className="mb-0 mt-3 text-sm text-muted">{message}</p>}
    </div>
  )
}

export default CreateCampaignForm
