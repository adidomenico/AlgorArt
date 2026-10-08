import { useWallet } from '@txnlab/use-wallet-react'
import { useState } from 'react'
import { parseAlgoToMicroAlgos } from '../../lib/format'
import { pledge } from '../../lib/transaction'

interface PledgeFormProps {
  appId: bigint
  /** Called after a successful pledge so the parent can refresh its state. */
  onPledged: () => void
}

const PledgeForm = ({ appId, onPledged }: PledgeFormProps) => {
  const { activeAddress, transactionSigner } = useWallet()
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const canSubmit = amount.trim() !== '' && !busy && Boolean(activeAddress && transactionSigner)

  const handleSubmit = async () => {
    // Defensive: the submit button is disabled while disconnected, so this is unreachable in the UI.
    /* v8 ignore next */
    if (!activeAddress) return

    setBusy(true)
    setMessage(null)
    try {
      const microAlgos = parseAlgoToMicroAlgos(amount)
      await pledge(appId, { address: activeAddress, signer: transactionSigner }, microAlgos)
      setAmount('')
      setMessage('Pledge sent!')
      onPledged()
    } catch {
      setMessage('Failed to pledge. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-5 border-t border-line pt-5">
      <h3 className="m-0 mb-3 text-lg">Back this campaign</h3>
      <input
        type="text"
        inputMode="decimal"
        placeholder="Amount in ALGO"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value)
        }}
        className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
      />
      <button
        type="button"
        className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!canSubmit}
        onClick={() => void handleSubmit()}
      >
        {busy ? 'Sending…' : 'Pledge'}
      </button>
      <p className="text-sm text-muted">Network fee ≈0.004 ALGO. Refunds stay open after failure - no opt-ins needed.</p>
      {message && <p className="mb-0 mt-3 text-sm text-muted">{message}</p>}
    </div>
  )
}

export default PledgeForm
