import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCampaignMetadata, parseCampaignMetadata, resolveImageSrc, resolveIpfsUri } from './metadata'

describe('resolveIpfsUri', () => {
  it('maps ipfs:// URIs onto the gateway', () => {
    expect(resolveIpfsUri('ipfs://QmExample/image.png')).toBe('https://ipfs.io/ipfs/QmExample/image.png')
  })

  it('passes https URLs through and trims whitespace', () => {
    expect(resolveIpfsUri('  https://example.com/m.json  ')).toBe('https://example.com/m.json')
  })
})

describe('parseCampaignMetadata', () => {
  it('picks the known string fields', () => {
    expect(
      parseCampaignMetadata({
        name: 'Novel',
        description: 'A story',
        image: 'ipfs://QmImg',
        category: 'books',
        extra: 42,
      }),
    ).toEqual({ name: 'Novel', description: 'A story', image: 'ipfs://QmImg', category: 'books' })
  })

  it('returns null for non-objects and empty blobs', () => {
    expect(parseCampaignMetadata(null)).toBeNull()
    expect(parseCampaignMetadata('novel')).toBeNull()
    expect(parseCampaignMetadata({})).toBeNull()
    expect(parseCampaignMetadata({ name: '   ' })).toBeNull()
  })
})

describe('fetchCampaignMetadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches and parses the blob', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ image: 'ipfs://QmImg' }) })
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchCampaignMetadata('ipfs://QmMeta')).toEqual({
      name: undefined,
      description: undefined,
      image: 'ipfs://QmImg',
      category: undefined,
    })
    expect(fetchMock).toHaveBeenCalledWith('https://ipfs.io/ipfs/QmMeta')
  })

  it('returns null without fetching on blank URIs', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchCampaignMetadata('  ')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null on HTTP errors and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) }))
    expect(await fetchCampaignMetadata('https://example.com/m.json')).toBeNull()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await fetchCampaignMetadata('https://example.com/m.json')).toBeNull()
  })
})

describe('resolveImageSrc', () => {
  it('prefers the blob image field', () => {
    expect(resolveImageSrc('ipfs://QmMeta', { image: 'ipfs://QmImg' })).toBe('https://ipfs.io/ipfs/QmImg')
  })

  it('falls back to the URI itself for direct image links', () => {
    expect(resolveImageSrc('https://example.com/cover.jpg', null)).toBe('https://example.com/cover.jpg')
    expect(resolveImageSrc('ipfs://QmMeta', null)).toBeNull()
  })
})
