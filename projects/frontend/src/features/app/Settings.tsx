import { useNetwork, useWallet } from '@txnlab/use-wallet-react'
import { useEffect, useState } from 'react'
import { adaptSignData } from '../../lib/backend'
import { fetchSettings, saveSettings } from '../../lib/profiles'

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
    let cancelled = false
    // fetchSettings resolves null on every failure path, so no catch is needed.
    void fetchSettings({ address: activeAddress, chainId: activeNetworkConfig.caipChainId, sign: adaptSignData(signData) })
      .then((s) => {
        if (!cancelled && s) {
          setNotifyFunded(s.notify_funded)
          setNotifyFailed(s.notify_failed)
          setTheme(s.theme as 'light' | 'dark' | 'system')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeAddress, activeNetworkConfig.caipChainId, signData])

  const handleSave = async () => {
    // Defensive: the form only renders while connected, so this is unreachable in the UI.
    /* v8 ignore next */
    if (!activeAddress || !activeWallet) {
      setError('Wallet not connected.')
      return
    }
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const updated = await saveSettings({
        address: activeAddress,
        chainId: activeNetworkConfig.caipChainId,
        sign: adaptSignData(signData),
        notifyFunded,
        notifyFailed,
        theme,
      })
      setNotifyFunded(updated.notify_funded)
      setNotifyFailed(updated.notify_failed)
      setTheme(updated.theme as 'light' | 'dark' | 'system')
      setSuccess('Settings saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  if (!activeAddress) {
    return (
      <div className="mx-auto max-w-md py-12 text-center">
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
    <div className="mx-auto max-w-md space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        <button type="button" className="cursor-pointer text-sm text-muted hover:text-ink" onClick={onBack}>
          ← Back
        </button>
      </div>

      <div className="space-y-6">
        <fieldset className="space-y-4 rounded-lg border border-line p-4">
          <legend className="px-2 text-sm font-medium text-muted">Notifications</legend>
          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="notify-funded" className="block text-sm">
                Funded campaigns
              </label>
              <p className="text-xs text-muted">Email me when a campaign I backed reaches its goal.</p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                id="notify-funded"
                type="checkbox"
                checked={notifyFunded}
                onChange={(e) => {
                  setNotifyFunded(e.target.checked)
                }}
                className="peer sr-only"
              />
              <div className="peer h-6 w-11 rounded-full bg-muted/50 peer-checked:bg-teal peer-focus:ring-2 peer-focus:ring-teal peer-focus:outline-none after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
            </label>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <label htmlFor="notify-failed" className="block text-sm">
                Failed campaigns
              </label>
              <p className="text-xs text-muted">Email me when a campaign I backed fails and I can refund.</p>
            </div>
            <label className="relative inline-flex cursor-pointer items-center">
              <input
                id="notify-failed"
                type="checkbox"
                checked={notifyFailed}
                onChange={(e) => {
                  setNotifyFailed(e.target.checked)
                }}
                className="peer sr-only"
              />
              <div className="peer h-6 w-11 rounded-full bg-muted/50 peer-checked:bg-teal peer-focus:ring-2 peer-focus:ring-teal peer-focus:outline-none after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white"></div>
            </label>
          </div>
        </fieldset>

        <fieldset className="space-y-4 rounded-lg border border-line p-4">
          <legend className="px-2 text-sm font-medium text-muted">Appearance</legend>
          <div>
            <label className="mb-2 block text-sm">Theme</label>
            <div className="flex gap-4">
              {(['light', 'dark', 'system'] as const).map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="radio"
                    name="theme"
                    value={t}
                    checked={theme === t}
                    onChange={() => {
                      setTheme(t)
                    }}
                    className="peer sr-only"
                  />
                  <div
                    className={`rounded-md border px-4 py-2 text-sm transition-colors ${
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

        {error && <div className="text-sm text-danger">{error}</div>}
        {success && <div className="text-sm text-teal-dark">{success}</div>}

        <button
          type="button"
          disabled={saving || loading}
          className="w-full cursor-pointer rounded-md border border-teal bg-teal px-4 py-2 text-sm text-white hover:border-teal-dark hover:bg-teal-dark disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}

export default Settings
