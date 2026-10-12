import { useNetwork, useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import { adaptSignData } from '../../lib/backend'
import { clearSettingsCache, fetchSettings, saveSettings } from '../../lib/profiles'

interface SettingsProps {
  onBack: () => void
}

const Settings = ({ onBack }: SettingsProps) => {
  const { activeAddress, activeWallet, signData } = useWallet()
  const { activeNetworkConfig } = useNetwork()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notifyFunded, setNotifyFunded] = useState(true)
  const [notifyFailed, setNotifyFailed] = useState(true)
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  useEffect(() => {
    if (!activeAddress) {
      setLoading(false)
      return
    }
    setLoading(true)
    fetchSettings(activeAddress)
      .then((s) => {
        if (s) {
          setNotifyFunded(s.notify_funded)
          setNotifyFailed(s.notify_failed)
          setTheme(s.theme as 'light' | 'dark' | 'system')
        }
      })
      .catch(() => {
        // Settings fetch failed - form uses defaults
      })
      .finally(() => {
        setLoading(false)
      })
  }, [activeAddress])

  const handleSave = async () => {
    if (!activeAddress || !activeWallet || !signData) {
      setError('Wallet not connected.')
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      await saveSettings({
        address: activeAddress,
        chainId: activeNetworkConfig?.caipChainId,
        sign: adaptSignData(signData),
        notifyFunded,
        notifyFailed,
        theme,
      })
      clearSettingsCache()
      const updated = await fetchSettings(activeAddress)
      if (updated) {
        setNotifyFunded(updated.notify_funded)
        setNotifyFailed(updated.notify_failed)
        setTheme(updated.theme as 'light' | 'dark' | 'system')
      }
      setSuccess('Settings saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  if (!activeAddress) {
    return (
      <div className="max-w-md mx-auto text-center py-12">
        <p className="text-muted">Connect your wallet to manage settings.</p>
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
    <div className="max-w-md mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <button type="button" className="cursor-pointer text-sm text-muted hover:text-ink" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="space-y-6">
        <fieldset className="space-y-4 border border-line rounded-lg p-4">
          <legend className="text-sm font-medium text-muted px-2">Notifications</legend>
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm">Funded campaigns</label>
              <p className="text-xs text-muted">Email me when a campaign I backed reaches its goal.</p>
            </div>
            <label className="cursor-pointer relative inline-flex items-center">
              <input type="checkbox" checked={notifyFunded} onChange={(e) => setNotifyFunded(e.target.checked)} className="sr-only peer" />
              <div className="w-11 h-6 bg-muted/50 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-teal rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-teal"></div>
            </label>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label className="block text-sm">Failed campaigns</label>
              <p className="text-xs text-muted">Email me when a campaign I backed fails and I can refund.</p>
            </div>
            <label className="cursor-pointer relative inline-flex items-center">
              <input type="checkbox" checked={notifyFailed} onChange={(e) => setNotifyFailed(e.target.checked)} className="sr-only peer" />
              <div className="w-11 h-6 bg-muted/50 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-teal rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-teal"></div>
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-4 border border-line rounded-lg p-4">
          <legend className="text-sm font-medium text-muted px-2">Appearance</legend>
          <div>
            <label className="block text-sm mb-2">Theme</label>
            <div className="flex gap-4">
              {(['light', 'dark', 'system'] as const).map((t) => (
                <label key={t} className="cursor-pointer flex items-center gap-2">
                  <input type="radio" name="theme" value={t} checked={theme === t} onChange={() => setTheme(t)} className="sr-only peer" />
                  <div
                    className={`px-4 py-2 rounded-md border text-sm transition-colors ${
                      theme === t ? 'border-teal bg-teal/10 text-teal' : 'border-line hover:border-teal/50'
                    }`}
                  >
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </div>
                </label>
              ))}
            </div>
          </div>
        </fieldset>

        {error && <div className="text-sm text-red">{error}</div>}
        {success && <div className="text-sm text-green">{success}</div>}

        <button
          type="button"
          disabled={saving || loading}
          className="w-full cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}

export default Settings
