import { useNetwork, useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import { adaptSignData } from '../../lib/backend'
import { fetchProfile, saveProfile } from '../../lib/profiles'
import { ellipseAddress } from '../../utils/ellipseAddress'
import { orEmpty } from '../../utils/orEmpty'

interface ProfileProps {
  onBack: () => void
}

const Profile = ({ onBack }: ProfileProps) => {
  const { activeAddress, signData } = useWallet()
  const { activeNetworkConfig } = useNetwork()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [avatarCid, setAvatarCid] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (!activeAddress) {
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    // fetchProfile resolves null on every failure path, so no catch is needed.
    void fetchProfile(activeAddress)
      .then((p) => {
        if (!cancelled && p) {
          setDisplayName(orEmpty(p.display_name))
          setBio(orEmpty(p.bio))
          setAvatarCid(orEmpty(p.avatar_cid))
          setEmail(orEmpty(p.email))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeAddress])

  const handleSave = async () => {
    // Defensive: the form only renders while connected, so this is unreachable in the UI.
    /* v8 ignore next */
    if (!activeAddress) {
      setError('Wallet not connected.')
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const updated = await saveProfile({
        address: activeAddress,
        chainId: activeNetworkConfig.caipChainId,
        sign: adaptSignData(signData),
        displayName,
        bio,
        avatarCid,
        email,
      })
      setDisplayName(orEmpty(updated.display_name))
      setBio(orEmpty(updated.bio))
      setAvatarCid(orEmpty(updated.avatar_cid))
      setEmail(orEmpty(updated.email))
      setSuccess('Profile saved.')
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!activeAddress) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <p className="text-muted">Connect your wallet to view your profile.</p>
        <button
          type="button"
          className="mt-4 cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark"
          onClick={onBack}
        >
          Back
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Profile</h1>
        <button type="button" className="cursor-pointer text-sm text-muted hover:text-ink" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm text-muted">Address</label>
          <div className="rounded bg-muted/20 px-3 py-2 font-mono text-sm">{ellipseAddress(activeAddress)}</div>
        </div>

        <div>
          <label htmlFor="displayName" className="mb-1 block text-sm text-muted">
            Display Name
          </label>
          <input
            id="displayName"
            type="text"
            maxLength={64}
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value)
            }}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm focus:border-teal focus:ring-1 focus:ring-teal focus:outline-none"
            placeholder="Your name"
          />
        </div>

        <div>
          <label htmlFor="bio" className="mb-1 block text-sm text-muted">
            Bio
          </label>
          <textarea
            id="bio"
            maxLength={1000}
            value={bio}
            onChange={(e) => {
              setBio(e.target.value)
            }}
            rows={3}
            className="w-full resize-none rounded-md border border-line bg-card px-3 py-2 text-sm focus:border-teal focus:ring-1 focus:ring-teal focus:outline-none"
            placeholder="Tell us about yourself"
          />
        </div>

        <div>
          <label htmlFor="avatarCid" className="mb-1 block text-sm text-muted">
            Avatar CID (IPFS)
          </label>
          <input
            id="avatarCid"
            type="text"
            maxLength={128}
            value={avatarCid}
            onChange={(e) => {
              setAvatarCid(e.target.value)
            }}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm focus:border-teal focus:ring-1 focus:ring-teal focus:outline-none"
            placeholder="Qm... (optional)"
          />
        </div>

        <div>
          <label htmlFor="email" className="mb-1 block text-sm text-muted">
            Email (for notifications)
          </label>
          <input
            id="email"
            type="email"
            maxLength={320}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
            }}
            className="w-full rounded-md border border-line bg-card px-3 py-2 text-sm focus:border-teal focus:ring-1 focus:ring-teal focus:outline-none"
            placeholder="you@example.com (optional)"
          />
        </div>

        {error && <div className="text-sm text-danger">{error}</div>}
        {success && <div className="text-sm text-teal-dark">{success}</div>}

        <button
          type="button"
          disabled={saving || loading}
          className="w-full cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save Profile'}
        </button>
      </div>
    </div>
  )
}

export default Profile
