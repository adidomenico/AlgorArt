import { useWallet } from '@txnlab/use-wallet-react'
import { useState } from 'react'
import { parseAlgoToMicroAlgos } from '../../lib/format'
import { createCampaign } from '../../lib/transaction'

interface CreateCampaignFormProps {
  /** Called with the new app id after a successful create. */
  onCreated: (appId: bigint) => void
  onCancel: () => void
}

const CreateCampaignForm = ({ onCreated, onCancel }: CreateCampaignFormProps) => {
  const { activeAddress, transactionSigner } = useWallet()
  const [goal, setGoal] = useState('')
  const [days, setDays] = useState('30')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const canSubmit = goal.trim() !== '' && !busy && Boolean(activeAddress && transactionSigner)

  const handleSubmit = async () => {
    if (!activeAddress || !transactionSigner) return

    setBusy(true)
    setMessage(null)
    try {
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
      const deadlineSeconds = BigInt(Math.floor(Date.now() / 1000) + daysNumber * 86_400)

      const { appId } = await createCampaign({ address: activeAddress, signer: transactionSigner }, goalMicroAlgos, deadlineSeconds)
      onCreated(appId)
    } catch {
      setMessage('Failed to create campaign. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="create">
      <h3 className="create__title">Create a campaign</h3>
      <label className="create__field">
        Goal (ALGO)
        <input type="text" inputMode="decimal" placeholder="e.g. 100" value={goal} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <label className="create__field">
        Duration (days)
        <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} />
      </label>
      <div className="create__actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn--primary" disabled={!canSubmit} onClick={() => void handleSubmit()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      {message && <p className="create__message">{message}</p>}
    </div>
  )
}

export default CreateCampaignForm
