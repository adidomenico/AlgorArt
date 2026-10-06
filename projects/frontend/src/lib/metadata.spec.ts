import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCampaignMetadata, looksResolvable, parseCampaignMetadata, resolveImageSrc, resolveIpfsUri } from './metadata'

describe('resolveIpfsUri', () => {
  it('maps ipfs:// URIs onto the gateway', () => {
    expect(resolveIpfsUri('ipfs://QmExample/image.png')).toBe('https://gateway.pinata.cloud/ipfs/QmExample/image.png')
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
        image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
        category: 'books',
        extra: 42,
      }),
    ).toEqual({
      name: 'Novel',
      description: 'A story',
      image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      category: 'books',
    })
  })

  it('returns null for non-objects and empty blobs', () => {
    expect(parseCampaignMetadata(null)).toBeNull()
    expect(parseCampaignMetadata('novel')).toBeNull()
    expect(parseCampaignMetadata({})).toBeNull()
    expect(parseCampaignMetadata({ name: '   ' })).toBeNull()
  })
})

describe('looksResolvable', () => {
  it('accepts real CIDs and https URLs', () => {
    expect(looksResolvable('ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toBe(true)
    expect(looksResolvable('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toBe(true)
    expect(looksResolvable('https://example.com/m.json')).toBe(true)
  })

  it('rejects blanks and obviously-fake ipfs pointers without fetching', async () => {
    expect(looksResolvable('  ')).toBe(false)
    expect(looksResolvable('ipfs://seed/bob')).toBe(false)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchCampaignMetadata('ipfs://seed/bob')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('fetchCampaignMetadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches and parses the blob', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchCampaignMetadata('ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).toEqual({
      name: undefined,
      description: undefined,
      image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      category: undefined,
    })
    expect(fetchMock).toHaveBeenCalledWith('https://gateway.pinata.cloud/ipfs/QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')
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
    expect(
      resolveImageSrc('ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', {
        image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      }),
    ).toBe('https://gateway.pinata.cloud/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')
  })

  it('falls back to the URI itself for direct image links', () => {
    expect(resolveImageSrc('https://example.com/cover.jpg', null)).toBe('https://example.com/cover.jpg')
    expect(resolveImageSrc('ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', null)).toBeNull()
  })
})
