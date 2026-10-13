import { useNetwork, useWallet } from '@txnlab/use-wallet-react'
import { useState } from 'react'
import { fetchChainTimestamp } from '../../lib/algorand'
import { adaptSignData, backendUrl, uploadCover, uploadMetadata } from '../../lib/backend'
import { classifyError, errorMessage } from '../../lib/errors'
import { parseAlgoToMicroAlgos } from '../../lib/format'
import { logError } from '../../lib/log'
import { createCampaign, disconnectQuietly } from '../../lib/transaction'

interface CreateCampaignFormProps {
  /** Called with the new app id after a successful create. */
  onCreated: (appId: bigint) => void
  onCancel: () => void
}

const CATEGORIES = ['Art', 'Music', 'Film', 'Games', 'Books', 'Tech']

const CreateCampaignForm = ({ onCreated, onCancel }: CreateCampaignFormProps) => {
  const { activeAddress, activeWallet, signData, transactionSigner } = useWallet()
  const { activeNetworkConfig } = useNetwork()
  const [title, setTitle] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
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

      let metadataUri = ''
      if (imageFile !== null) {
        try {
          const sign = adaptSignData(signData)
          const baseUrl = backendUrl()
          const address = activeAddress
          const chainId = activeNetworkConfig.caipChainId
          const coverUri = await uploadCover({ baseUrl, address, chainId, sign, file: imageFile })
          metadataUri = await uploadMetadata({
            baseUrl,
            address,
            chainId,
            sign,
            name: title.trim(),
            description: description.trim(),
            image: coverUri,
            category,
          })
        } catch (error) {
          setMessage((error as Error).message)
          return
        }
      }
      if (new TextEncoder().encode(metadataUri).length > MAX_BYTES) {
        setMessage('Metadata URI must be 128 bytes or fewer.')
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
    } catch (error) {
      logError('create', error)
      const kind = classifyError(error)
      if (kind === 'session') {
        if (activeWallet) {
          void disconnectQuietly(activeWallet)
          setMessage('Wallet session expired. Connect your wallet again to continue.')
        } else {
          setMessage('Wallet session expired. Disconnect and reconnect your wallet, then try again.')
        }
      } else {
        setMessage(errorMessage(kind, 'create'))
      }
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
      <div className="mb-3 flex items-center gap-2">
        <label
          htmlFor="cover-file"
          className="cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark"
        >
          Choose cover
        </label>
        <input
          id="cover-file"
          type="file"
          accept="image/*"
          onChange={(e) => {
            // Change events always carry a FileList (possibly empty) - the cast only satisfies the nullable DOM type.
            const files = e.target.files as FileList
            setImageFile(files[0] ?? null)
          }}
          className="hidden"
        />
        <span className="min-w-0 flex-1 truncate text-sm text-muted">{imageFile?.name ?? 'No file chosen'}</span>
      </div>
      <label className="mb-3 block text-sm text-muted">
        Description (optional)
        <textarea
          placeholder="What is this campaign about?"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value)
          }}
          rows={3}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        />
      </label>
      <label className="mb-3 block text-sm text-muted">
        Category (optional)
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
          }}
          className="mb-3 w-full rounded-md border border-line px-3 py-2 focus:border-teal focus:outline-none"
        >
          <option value="">Select a category</option>
          {CATEGORIES.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
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
      {message && <p className="mt-3 mb-0 text-sm text-muted">{message}</p>}
    </div>
  )
}

export default CreateCampaignForm
