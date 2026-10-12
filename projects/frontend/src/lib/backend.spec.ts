import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoverUpload } from './backend'
import { backendUrl, uploadCover } from './backend'

function uploadInput(overrides: Partial<CoverUpload> = {}): CoverUpload {
  return {
    baseUrl: 'http://backend',
    address: 'ADDRESS',
    sign: () => Promise.resolve(new Uint8Array([1, 2, 3])),
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
      .mockResolvedValueOnce(okJson({ message: 'challenge' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
      .mockResolvedValueOnce(okJson({ cid: 'QmCover' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(uploadCover(uploadInput())).resolves.toBe('ipfs://QmCover')
    const calls = fetchMock.mock.calls as unknown[][]
    expect(calls[0]?.[0]).toBe('http://backend/auth/challenge')
    const verifyInit = calls[1]?.[1] as { body?: unknown } | undefined
    expect(verifyInit?.body).toContain('"message":"challenge"')
    const uploadInit = calls[2]?.[1] as { headers?: unknown; body?: unknown } | undefined
    expect(uploadInit?.headers).toEqual({ authorization: 'Bearer session', 'content-type': 'image/png' })
    expect(uploadInit?.body).toBeInstanceOf(File)
  })

  it('sends the wallet signature as base64', async () => {
    const sign = () => Promise.resolve(Uint8Array.from([72, 69, 76, 76, 79]))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ message: 'challenge' }))
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
        .mockResolvedValueOnce(okJson({ message: 'challenge' }))
        .mockResolvedValueOnce({ status: 400, json: () => Promise.resolve({}) }),
    )
    await expect(uploadCover(uploadInput())).rejects.toThrow('Sign-in failed')
  })

  it('throws on a malformed session', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ message: 'challenge' }))
        .mockResolvedValueOnce(okJson({})),
    )
    await expect(uploadCover(uploadInput())).rejects.toThrow('Sign-in failed')
  })

  it('lets wallet rejections propagate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ message: 'challenge' })))
    const sign = () => Promise.reject(new Error('rejected in wallet'))
    await expect(uploadCover(uploadInput({ sign }))).rejects.toThrow('rejected in wallet')
  })

  it('throws when pinning fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ message: 'challenge' }))
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
        .mockResolvedValueOnce(okJson({ message: 'challenge' }))
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
        .mockResolvedValueOnce(okJson({ message: 'challenge' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockRejectedValueOnce(new Error('offline')),
    )
    await expect(uploadCover(uploadInput())).rejects.toThrow('Is the backend reachable?')
  })
})
