import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProfileInput, SettingsInput } from './profiles'
import { clearProfileCache, clearSettingsCache, fetchProfile, fetchSettings, saveProfile, saveSettings } from './profiles'

function profileInput(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    address: 'ADDRESS',
    chainId: 'algorand:testnet',
    sign: () => Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) }),
    displayName: 'Kyogre Fan',
    bio: 'Collector',
    avatarCid: 'QmAvatar',
    email: 'kyogre@example.com',
    ...overrides,
  }
}

function settingsInput(overrides: Partial<SettingsInput> = {}): SettingsInput {
  return {
    address: 'ADDRESS',
    chainId: 'algorand:testnet',
    sign: () => Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) }),
    notifyFunded: true,
    notifyFailed: true,
    theme: 'system',
    ...overrides,
  }
}

function okJson(json: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(json) }
}

function notOkJson(status: number): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: false, status, json: () => Promise.resolve({}) }
}

describe('fetchProfile', () => {
  afterEach(() => {
    clearProfileCache()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('returns the profile when backend is configured', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi.fn().mockResolvedValue(okJson({ display_name: 'Kyogre Fan', bio: 'Collector', avatar_cid: 'QmAvatar', email: 'kyogre@example.com' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProfile('ADDRESS')).resolves.toEqual({
      address: 'ADDRESS',
      display_name: 'Kyogre Fan',
      bio: 'Collector',
      avatar_cid: 'QmAvatar',
      email: 'kyogre@example.com',
    })
    expect(fetchMock).toHaveBeenCalledWith('http://backend/profiles?address=ADDRESS')
  })

  it('caches profiles per address', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi.fn().mockResolvedValue(okJson({ display_name: 'Kyogre Fan' }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchProfile('ADDRESS')
    await fetchProfile('ADDRESS')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats blank names as missing', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ display_name: '', bio: 7 })))

    await expect(fetchProfile('ADDRESS')).resolves.toEqual({ address: 'ADDRESS', display_name: null, bio: null, avatar_cid: null, email: null })
  })

  it('treats malformed profiles as missing', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi.fn().mockResolvedValueOnce(okJson({})).mockResolvedValueOnce(okJson('oops'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProfile('ADDRESS')).resolves.toEqual({ address: 'ADDRESS', display_name: null, bio: null, avatar_cid: null, email: null })
    clearProfileCache()
    await expect(fetchProfile('ADDRESS')).toBeNull()
  })

  it('returns null without a backend or address', async () => {
    // When VITE_BACKEND_URL is empty, fetchProfile returns null immediately
    const { rows } = await import('../lib/backend.ts')
    ;(rows as any).backendUrl = () => ''
    await expect(fetchProfile('ADDRESS')).resolves.toBeNull()
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    await expect(fetchProfile('ADDRESS')).resolves.toEqual(expect.objectContaining({ address: 'ADDRESS' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on HTTP errors and network failures', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(notOkJson(404))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchProfile('ADDRESS')).resolves.toBeNull()
    clearProfileCache()
    await expect(fetchProfile('ADDRESS')).resolves.toBeNull()
  })
})

describe('saveProfile', () => {
  afterEach(() => {
    clearProfileCache()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('signs in, saves, and caches the profile', async () {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ display_name: 'Kyogre Fan', bio: 'Collector', avatar_cid: 'QmAvatar', email: 'kyogre@example.com' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(saveProfile(profileInput())).resolves.toEqual({
      address: 'ADDRESS',
      display_name: 'Kyogre Fan',
      bio: 'Collector',
      avatar_cid: 'QmAvatar',
      email: 'kyogre@example.com',
    })
    const calls = fetchMock.mock.calls as unknown[][]
    const saveInit = calls[2]?.[1] as { body?: unknown } | undefined
    expect(saveInit?.body).toEqual(JSON.stringify({ display_name: 'Kyogre Fan', bio: 'Collector', avatar_cid: 'QmAvatar', email: 'kyogre@example.com' }))
    await expect(fetchProfile('ADDRESS')).resolves.toEqual({
      address: 'ADDRESS',
      display_name: 'Kyogre Fan',
      bio: 'Collector',
      avatar_cid: 'QmAvatar',
      email: 'kyogre@example.com',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('clears blank fields', async () {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ display_name: null, bio: null, avatar_cid: null, email: null }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(saveProfile(profileInput({ displayName: '', bio: '', avatarCid: '', email: '' }))).resolves.toEqual({
      address: 'ADDRESS',
      display_name: null,
      bio: null,
      avatar_cid: null,
      email: null,
    })
    const calls = fetchMock.mock.calls as unknown[][]
    const saveInit = calls[2]?.[1] as { body?: unknown } | undefined
    expect(saveInit?.body).toEqual(JSON.stringify({ display_name: null, bio: null, avatar_cid: null, email: null }))
  })

  it('throws when the backend is not configured', async () => {
    vi.stubEnv('VITE_BACKEND_URL', '')
    await expect(saveProfile(profileInput({}))).rejects.toThrow('VITE_BACKEND_URL')
  })

  it('throws when the challenge is unreachable', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(saveProfile(profileInput())).rejects.toThrow('Could not start the profile update')
  })

  it('throws when saving fails', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce({ status: 400, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(saveProfile(profileInput())).rejects.toThrow('Saving failed. Try again.')
  })

  it('throws when the save is unreachable', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockRejectedValueOnce(new Error('offline')),
    )
    await expect(saveProfile(profileInput())).rejects.toThrow('Is the backend reachable?')
  })

  it('throws on a malformed save response', async () {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce(okJson('oops')),
    )
    await expect(saveProfile(profileInput())).rejects.toThrow('Saving failed. Try again.')
  })
})

describe('fetchSettings', () => {
  afterEach(() => {
    clearSettingsCache()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('returns the settings when backend is configured', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ notify_funded: false, notify_failed: true, theme: 'dark' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchSettings('ADDRESS')).resolves.toEqual({
      address: 'ADDRESS',
      notify_funded: false,
      notify_failed: true,
      theme: 'dark',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('caches settings per address', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ notify_funded: false, notify_failed: true, theme: 'dark' }))
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ notify_funded: false, notify_failed: true, theme: 'dark' }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchSettings('ADDRESS')
    await fetchSettings('ADDRESS')

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('returns null without a backend or address', async () => {
    const { rows } = await import('../lib/backend.ts')
    ;(rows as any).backendUrl = () => ''
    await expect(fetchSettings('ADDRESS')).resolves.toBeNull()
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    await expect(fetchSettings('ADDRESS')).resolves.toEqual(expect.objectContaining({ address: 'ADDRESS' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('saveSettings', () => {
  afterEach(() => {
    clearSettingsCache()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('signs in, saves, and caches the settings', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ notify_funded: false, notify_failed: true, theme: 'dark' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(saveSettings(settingsInput({ notifyFunded: false, theme: 'dark' }))).resolves.toEqual({
      address: 'ADDRESS',
      notify_funded: false,
      notify_failed: true,
      theme: 'dark',
    })
    const calls = fetchMock.mock.calls as unknown[][]
    const saveInit = calls[2]?.[1] as { body?: unknown } | undefined
    expect(saveInit?.body).toEqual(JSON.stringify({ notify_funded: false, notify_failed: true, theme: 'dark' }))
    await expect(fetchSettings('ADDRESS')).resolves.toEqual({
      address: 'ADDRESS',
      notify_funded: false,
      notify_failed: true,
      theme: 'dark',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('throws when the backend is not configured', async () => {
    vi.stubEnv('VITE_BACKEND_URL', '')
    await expect(saveSettings(settingsInput({}))).rejects.toThrow('VITE_BACKEND_URL')
  })

  it('throws when the challenge is unreachable', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(saveSettings(settingsInput({}))).rejects.toThrow('Could not start the settings update')
  })

  it('throws when saving fails', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce({ status: 400, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(saveSettings(settingsInput({}))).rejects.toThrow('Saving failed. Try again.')
  })

  it('throws when the save is unreachable', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockRejectedValueOnce(new Error('offline')),
    )
    await expect(saveSettings(settingsInput({}))).rejects.toThrow('Is the backend reachable?')
  })

  it('throws on a malformed save response', async () {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce(okJson('oops')),
    )
    await expect(saveSettings(settingsInput({}))).rejects.toThrow('Saving failed. Try again.')
  })

  it('throws when nothing to update', async () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    await expect(saveSettings({ address: 'ADDRESS', chainId: 'algorand:testnet', sign: () => Promise.resolve({ signature: new Uint8Array(), authenticatorData: new Uint8Array() }) })).rejects.toThrow('Nothing to update.')
  })
})