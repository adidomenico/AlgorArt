import { ScopeType } from '@txnlab/use-wallet'
import algosdk from 'algosdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoverUpload, MetadataUpload, SignIn } from './backend'
import {
  adaptSignData,
  adaptSignTransaction,
  backendUrl,
  clearSession,
  ensureSession,
  signInWithTransaction,
  uploadCover,
  uploadMetadata,
} from './backend'

const { algodParamsMock } = vi.hoisted(() => ({ algodParamsMock: vi.fn() }))

vi.mock('./algorand', () => ({
  algorand: { client: { algod: { getTransactionParams: () => ({ do: () => algodParamsMock() }) } } },
}))

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

describe('adaptSignData', () => {
  it('calls signData with the ARC-60 shape and maps the response', async () => {
    const signData = vi.fn().mockResolvedValue({ signature: new Uint8Array([1]), authenticatorData: new Uint8Array([2]), extra: true })

    await expect(adaptSignData(signData)('cGF5bG9hZA==')).resolves.toEqual({
      signature: new Uint8Array([1]),
      authenticatorData: new Uint8Array([2]),
    })
    expect(signData).toHaveBeenCalledWith('cGF5bG9hZA==', { encoding: 'base64', scope: ScopeType.AUTH })
  })
})

describe('ensureSession', () => {
  afterEach(() => {
    clearSession()
    vi.unstubAllGlobals()
  })

  function sessionInput(overrides: Partial<SignIn> = {}): SignIn {
    return {
      baseUrl: 'http://backend',
      address: 'ADDRESS',
      chainId: 'algorand:testnet',
      sign: () => Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) }),
      statement: 'Sign in.',
      action: 'upload',
      ...overrides,
    }
  }

  function signInFlow(token: string) {
    return vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'n' }))
      .mockResolvedValueOnce(okJson({ token }))
  }

  it('reuses the token for the same address without signing again', async () => {
    const sign = vi.fn().mockResolvedValue({ signature: new Uint8Array([1]), authenticatorData: new Uint8Array([2]) })
    vi.stubGlobal('fetch', signInFlow('session'))

    await expect(ensureSession(sessionInput({ sign }))).resolves.toBe('session')
    await expect(ensureSession(sessionInput({ sign }))).resolves.toBe('session')
    expect(sign).toHaveBeenCalledOnce()
  })

  it('signs in fresh for a different address', async () => {
    const sign = vi.fn().mockResolvedValue({ signature: new Uint8Array([1]), authenticatorData: new Uint8Array([2]) })
    vi.stubGlobal('fetch', signInFlow('session-a'))
    await expect(ensureSession(sessionInput({ sign, address: 'ADDRESS-A' }))).resolves.toBe('session-a')

    const secondFetch = signInFlow('session-b')
    vi.stubGlobal('fetch', secondFetch)
    await expect(ensureSession(sessionInput({ sign, address: 'ADDRESS-B' }))).resolves.toBe('session-b')

    expect(sign).toHaveBeenCalledTimes(2)
    const challengeInit = (secondFetch.mock.calls[0]?.[1] ?? {}) as { body?: unknown }
    expect(challengeInit.body).toContain('"address":"ADDRESS-B"')
  })

  it('falls back to the transaction proof when message signing is unsupported', async () => {
    const sign = vi.fn().mockRejectedValue(new Error('Method not supported: signData'))
    const signTxn = vi.fn().mockResolvedValue(new Uint8Array([7]))
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'n' }))
        .mockResolvedValueOnce(okJson({ nonce: 'n' }))
        .mockResolvedValueOnce(okJson({ token: 'session' })),
    )

    await expect(
      ensureSession(sessionInput({ address: txnAddress, sign, signTxn, getParams: () => Promise.resolve(fakeParams()) })),
    ).resolves.toBe('session')
    expect(signTxn).toHaveBeenCalledOnce()

    await expect(
      ensureSession(sessionInput({ address: txnAddress, sign, signTxn, getParams: () => Promise.resolve(fakeParams()) })),
    ).resolves.toBe('session')
    expect(sign).toHaveBeenCalledOnce()
    expect(signTxn).toHaveBeenCalledOnce()
  })

  it('rethrows dismissals without falling back', async () => {
    const sign = vi.fn().mockRejectedValue(new Error('Operation cancelled by user'))
    const signTxn = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(okJson({ nonce: 'n' })))

    await expect(ensureSession(sessionInput({ sign, signTxn, getParams: () => Promise.resolve(fakeParams()) }))).rejects.toThrow(
      'Operation cancelled by user',
    )
    expect(signTxn).not.toHaveBeenCalled()
  })

  it('rethrows capability errors without a transaction signer', async () => {
    const sign = vi.fn().mockRejectedValue(new Error('Method not supported: signData'))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(okJson({ nonce: 'n' })))

    await expect(ensureSession(sessionInput({ sign }))).rejects.toThrow('Method not supported')
  })
})

const txnAddress = algosdk.generateAccount().addr.toString()

function fakeParams(): algosdk.SuggestedParams {
  return {
    fee: BigInt(0),
    minFee: BigInt(1000),
    firstValid: BigInt(1),
    lastValid: BigInt(1001),
    genesisID: 'testnet-v1.0',
    genesisHash: new Uint8Array(32),
  }
}

describe('adaptSignTransaction', () => {
  it('returns the first signed blob', async () => {
    const unsigned = new Uint8Array([0])
    const signTransactions = vi.fn().mockResolvedValue([new Uint8Array([1, 2])])

    await expect(adaptSignTransaction(signTransactions)(unsigned)).resolves.toEqual(new Uint8Array([1, 2]))
    expect(signTransactions).toHaveBeenCalledWith([unsigned], [0])
  })

  it('rejects empty results', async () => {
    const signTransactions = vi.fn().mockResolvedValue([null])

    await expect(adaptSignTransaction(signTransactions)(new Uint8Array([0]))).rejects.toThrow('Sign-in failed')
  })
})

describe('signInWithTransaction', () => {
  afterEach(() => {
    clearSession()
    vi.unstubAllGlobals()
  })

  it('signs a zero self-payment carrying the challenge nonce', async () => {
    const seen: Uint8Array[] = []
    const signTxn = (unsigned: Uint8Array) => {
      seen.push(unsigned)
      return Promise.resolve(new Uint8Array([9, 9, 9]))
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
      .mockResolvedValueOnce(okJson({ token: 'session' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      signInWithTransaction({
        baseUrl: 'http://backend',
        address: txnAddress,
        signTxn,
        action: 'upload',
        getParams: () => Promise.resolve(fakeParams()),
      }),
    ).resolves.toBe('session')

    const unsigned = algosdk.decodeUnsignedTransaction(seen[0] ?? new Uint8Array())
    expect(unsigned.sender.toString()).toBe(txnAddress)
    expect(unsigned.payment?.receiver.toString()).toBe(txnAddress)
    expect(unsigned.payment?.amount).toBe(BigInt(0))
    expect(Buffer.from(unsigned.note).toString('utf8')).toBe(`kasakame login ${location.host} abc123`)

    const calls = fetchMock.mock.calls as unknown[][]
    expect(calls[1]?.[0]).toBe('http://backend/auth/verify-txn')
    const verifyInit = calls[1]?.[1] as { body?: unknown } | undefined
    expect(verifyInit?.body).toContain(`"address":"${txnAddress}"`)
    expect(verifyInit?.body).toContain('"signedTxn":"CQkJ"')
  })

  it('reports an unreachable backend on challenge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ status: 500, json: () => Promise.resolve(null) }))

    await expect(
      signInWithTransaction({
        baseUrl: 'http://backend',
        address: txnAddress,
        signTxn: () => Promise.resolve(new Uint8Array([7])),
        action: 'upload',
        getParams: () => Promise.resolve(fakeParams()),
      }),
    ).rejects.toThrow('Could not start the upload')
  })

  it('reports a rejected proof on verify', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'n' }))
        .mockResolvedValueOnce({ status: 400, json: () => Promise.resolve(null) }),
    )

    await expect(
      signInWithTransaction({
        baseUrl: 'http://backend',
        address: txnAddress,
        signTxn: () => Promise.resolve(new Uint8Array([7])),
        action: 'upload',
        getParams: () => Promise.resolve(fakeParams()),
      }),
    ).rejects.toThrow('Sign-in failed')
  })

  it('reads live params by default', async () => {
    algodParamsMock.mockResolvedValue(fakeParams())
    const signTxn = () => Promise.resolve(new Uint8Array([7]))
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'n' }))
        .mockResolvedValueOnce(okJson({ token: 'session' })),
    )

    await expect(signInWithTransaction({ baseUrl: 'http://backend', address: txnAddress, signTxn, action: 'upload' })).resolves.toBe(
      'session',
    )
    expect(algodParamsMock).toHaveBeenCalledOnce()
  })
})

describe('uploadCover', () => {
  afterEach(() => {
    clearSession()
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

  it('reuses the session across uploads', async () => {
    let signCalls = 0
    const sign = (_payload: string) => {
      signCalls += 1
      return Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) })
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce(okJson({ cid: 'QmCover' }))
        .mockResolvedValueOnce(okJson({ cid: 'QmCover2' })),
    )

    await expect(uploadCover(uploadInput({ sign }))).resolves.toBe('ipfs://QmCover')
    await expect(uploadCover(uploadInput({ sign }))).resolves.toBe('ipfs://QmCover2')
    expect(signCalls).toBe(1)
  })

  it('clears an expired session and signs in again', async () => {
    let signCalls = 0
    const sign = (_payload: string) => {
      signCalls += 1
      return Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) })
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'stale' }))
        .mockResolvedValueOnce({ status: 401, json: () => Promise.resolve({}) }),
    )

    await expect(uploadCover(uploadInput({ sign }))).rejects.toThrow('Session expired')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce(okJson({ cid: 'QmCover' })),
    )
    await expect(uploadCover(uploadInput({ sign }))).resolves.toBe('ipfs://QmCover')
    expect(signCalls).toBe(2)
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
    clearSession()
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

  it('clears an expired session and signs in again', async () => {
    let signCalls = 0
    const sign = (_payload: string) => {
      signCalls += 1
      return Promise.resolve({ signature: new Uint8Array([1, 2, 3]), authenticatorData: new Uint8Array([4, 5, 6]) })
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'stale' }))
        .mockResolvedValueOnce({ status: 401, json: () => Promise.resolve({}) }),
    )

    await expect(uploadMetadata(metadataInput({ sign }))).rejects.toThrow('Session expired')
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(okJson({ nonce: 'abc123' }))
        .mockResolvedValueOnce(okJson({ token: 'session' }))
        .mockResolvedValueOnce(okJson({ cid: 'QmMeta' })),
    )
    await expect(uploadMetadata(metadataInput({ sign }))).resolves.toBe('ipfs://QmMeta')
    expect(signCalls).toBe(2)
  })
})
