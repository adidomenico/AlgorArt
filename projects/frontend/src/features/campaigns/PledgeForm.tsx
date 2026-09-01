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
    <div className="pledge">
      <h3 className="pledge__title">Back this campaign</h3>
      <input
        type="text"
        inputMode="decimal"
        placeholder="Amount in ALGO"
        value={amount}
        onChange={(e) => {
          setAmount(e.target.value)
        }}
        className="pledge__input"
      />
      <button type="button" className="btn btn--primary" disabled={!canSubmit} onClick={() => void handleSubmit()}>
        {busy ? 'Sending…' : 'Pledge'}
      </button>
      {message && <p className="pledge__message">{message}</p>}
    </div>
  )
}

export default PledgeForm
