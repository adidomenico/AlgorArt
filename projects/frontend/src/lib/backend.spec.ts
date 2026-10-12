import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoverUpload, MetadataUpload } from './backend'
import { backendUrl, uploadCover, uploadMetadata } from './backend'

function uploadInput(overrides: Partial<CoverUpload> = {}): CoverUpload {
  return {
    baseUrl: 'http://backend',
    address: 'ADDRESS',
    chainId: 'algorand:testnet',
    sign: () => Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) }),
    file: new File(['bytes'], 'cover.png', { type: 'image/png' }),
    ...overrides,
  }
}

function okJson(json: unknown): { status: number; json: () => Promise<unknown> } {
  return { status: 200, json: () => Promise.resolve(json) }
}

describe('backendUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns the configured URL', () => {
    vi.stubEnv('VITE_BACKEND_URL', 'http://backend')
    expect(backendUrl()).toBe('http://backend')
  })

  it('returns empty when unconfigured', () => {
    vi.stubEnv('VITE_BACKEND_URL', undefined)
    expect(backendUrl()).toBe('')
  })
})

describe('uploadCover', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('signs in and returns the ipfs URI', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ cid: 'QmCover' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadCover(uploadInput())).resolves.toBe('ipfs://QmCover')
    const calls = fetchMock.mock.calls as unknown[][]
    expect(calls[0]?.[0]).toBe('http://backend/auth/challenge')
    expect(calls[2]?.[0]).toBe('http://backend/uploads?filename=cover.png')
    const verifyInit = calls[1]?.[1] as { body?: unknown } | undefined
    expect(verifyInit?.body).toContain('\\"nonce\\":\\"abc123\\"')
    expect(verifyInit?.body).toContain('\\"chain_id\\":\\"algorand:testnet\\"')
    // [4, 5, 6] in base64.
    expect(verifyInit?.body).toContain('"authenticatorData":"BAUG"')
    const uploadInit = calls[2]?.[1] as { headers?: unknown; body?: unknown } | undefined
    expect(uploadInit?.headers).toEqual({ authorization: 'Bearer session', 'content-type': 'image/png' })
    expect(uploadInit?.body).toBeInstanceOf(File)
  })

  it('signs canonical SIWA carrying the nonce', async () => {
    const payloads: string[] = []
    const sign = (payload: string) => {
      payloads.push(payload)
      return Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) })
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce(okJson({ cid: 'QmCover' })),
    )

    await uploadCover(uploadInput({ sign }))
    expect(payloads).toHaveLength(1)
    const siwa = JSON.parse(atob(String(payloads[0]))) as Record<string, unknown>
    expect(siwa).toMatchObject({
      account_address: 'ADDRESS',
      type: 'ed25519',
      version: '1',
      nonce: 'abc123',
      chain_id: 'algorand:testnet',
    })
    expect(siwa.domain).toBe(location.host)
    expect(siwa.uri).toBe(location.origin)
  })

  it('falls back to localnet without a chain id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ cid: 'QmCover' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadCover(uploadInput({ chainId: undefined }))).resolves.toBe('ipfs://QmCover')
    const calls = fetchMock.mock.calls as unknown[][]
    const verifyInit = calls[1]?.[1] as { body?: unknown } | undefined
    expect(verifyInit?.body).toContain('\\"chain_id\\":\\"algorand:localnet\\"')
  })

  it('encodes special characters in the filename', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ cid: 'QmCover' }))
    vi.stubGlobal('fetch', fetchMock)

    await uploadCover(uploadInput({ file: new File(['bytes'], 'Kyogre art (1).png', { type: 'image/png' }) }))
    const calls = fetchMock.mock.calls as unknown[][]
    expect(calls[2]?.[0]).toBe('http://backend/uploads?filename=Kyogre%20art%20(1).png')
  })

  it('sends the wallet signature as base64', async () => {
    const sign = () => Promise.resolve({ signature: Uint8Array.from([72, 69, 76, 76, 79]), authenticatorData: new Uint8Array([4, 5, 6]) })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ cid: 'QmCover' }))
    vi.stubGlobal('fetch', fetchMock)

    await uploadCover(uploadInput({ sign }))
    const calls = fetchMock.mock.calls as unknown[][]
    const verifyInit = calls[1]?.[1] as { body?: unknown } | undefined
    // 'HELLO' in base64.
    expect(verifyInit?.body).toContain('SEVMTE8=')
  })

  it('throws when the backend is not configured', async () => {
    await expect(uploadCover(uploadInput({ baseUrl: '' }))).rejects.toThrow('VITE_BACKEND_URL')
  })

  it('throws when the challenge is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(uploadCover(uploadInput())).rejects.toThrow('Could not start the upload')
  })

  it('throws on a malformed challenge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, json: () => Promise.reject(new Error('not json')) }))
    await expect(uploadCover(uploadInput())).rejects.toThrow('Could not start the upload')
  })

  it('throws when verification fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce({ status: 400, json: () => Promise.resolve({}) }),
    )
    await expect(uploadCover(uploadInput())).rejects.toThrow('Sign-in failed')
  })

  it('throws on a malformed session', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({})),
    )
    await expect(uploadCover(uploadInput())).rejects.toThrow('Sign-in failed')
  })

  it('lets wallet rejections propagate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ nonce: 'abc123' })))
    const sign = () => Promise.reject(new Error('rejected in wallet'))
    await expect(uploadCover(uploadInput({ sign }))).rejects.toThrow('rejected in wallet')
  })

  it('throws when pinning fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce({ status: 502, json: () => Promise.resolve({}) }),
    )
    await expect(uploadCover(uploadInput())).rejects.toThrow('Pinning failed. Try again.')
  })

  it('throws on a malformed pin response', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce(okJson({})),
    )
    await expect(uploadCover(uploadInput())).rejects.toThrow('Pinning failed. Try again.')
  })

  it('throws when the upload is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockRejectedValueOnce(new Error('offline')),
    )
    await expect(uploadCover(uploadInput())).rejects.toThrow('Is the backend reachable?')
  })
})

function metadataInput(overrides: Partial<MetadataUpload> = {}): MetadataUpload {
  return {
    baseUrl: 'http://backend',
    address: 'ADDRESS',
    chainId: 'algorand:testnet',
    sign: () => Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) }),
    name: 'Kyogre',
    description: 'A story',
    image: 'ipfs://QmCover',
    category: 'Games',
    ...overrides,
  }
}

describe('uploadMetadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pins metadata and returns the ipfs URI', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ cid: 'QmMeta' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadMetadata(metadataInput())).resolves.toBe('ipfs://QmMeta')
    const calls = fetchMock.mock.calls as unknown[][]
    expect(calls[2]?.[0]).toBe('http://backend/uploads/metadata')
    const metaInit = calls[2]?.[1] as { body?: unknown } | undefined
    expect(metaInit?.body).toEqual(JSON.stringify({ name: 'Kyogre', image: 'ipfs://QmCover', description: 'A story', category: 'Games' }))
  })

  it('omits blank optional fields', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ cid: 'QmMeta' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadMetadata(metadataInput({ description: '', category: '' }))).resolves.toBe('ipfs://QmMeta')
    const calls = fetchMock.mock.calls as unknown[][]
    const metaInit = calls[2]?.[1] as { body?: unknown } | undefined
    expect(metaInit?.body).toEqual(JSON.stringify({ name: 'Kyogre', image: 'ipfs://QmCover' }))
  })

  it('falls back to localnet without a chain id', async () => {
    const payloads: string[] = []
    const sign = (payload: string) => {
      payloads.push(payload)
      return Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) })
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce(okJson({ cid: 'QmMeta' })),
    )

    await uploadMetadata(metadataInput({ chainId: undefined, sign }))
    const siwa = JSON.parse(atob(String(payloads[0]))) as { chain_id?: unknown }
    expect(siwa.chain_id).toBe('algorand:localnet')
  })

  it('throws when the backend is not configured', async () => {
    await expect(uploadMetadata(metadataInput({ baseUrl: '' }))).rejects.toThrow('VITE_BACKEND_URL')
  })

  it('throws when the challenge is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(uploadMetadata(metadataInput())).rejects.toThrow('Could not start the metadata upload')
  })

  it('throws on a malformed challenge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, json: () => Promise.reject(new Error('not json')) }))
    await expect(uploadMetadata(metadataInput())).rejects.toThrow('Could not start the metadata upload')
  })

  it('throws when verification fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce({ status: 400, json: () => Promise.resolve({}) }),
    )
    await expect(uploadMetadata(metadataInput())).rejects.toThrow('Sign-in failed')
  })

  it('lets wallet rejections propagate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ nonce: 'abc123' })))
    const sign = () => Promise.reject(new Error('rejected in wallet'))
    await expect(uploadMetadata(metadataInput({ sign }))).rejects.toThrow('rejected in wallet')
  })

  it('throws when pinning fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce({ status: 502, json: () => Promise.resolve({}) }),
    )
    await expect(uploadMetadata(metadataInput())).rejects.toThrow('Metadata pinning failed. Try again.')
  })

  it('throws when the upload is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockRejectedValueOnce(new Error('offline')),
    )
    await expect(uploadMetadata(metadataInput())).rejects.toThrow('Is the backend reachable?')
  })
})
