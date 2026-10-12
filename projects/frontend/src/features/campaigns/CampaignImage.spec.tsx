import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CampaignImage from './CampaignImage'

describe('CampaignImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the blob image through the gateway', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ image: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' }),
      }),
    )
    render(<CampaignImage metadataUri="ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" title="Novel" />)
    const img = await screen.findByAltText('Novel')
    expect(img.getAttribute('src')).toBe(
      'https://green-cooperative-koi-991.mypinata.cloud/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
    )
  })

  it('renders the placeholder fallback for blank URIs', () => {
    render(<CampaignImage metadataUri="  " title="Novel" />)
    const img = screen.getByAltText('Novel')
    expect(img.getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('shows the placeholder fallback when the image fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ image: 'https://example.com/cover.jpg' }) }))
    render(<CampaignImage metadataUri="ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" title="Novel" />)
    const img = await screen.findByAltText('Novel')
    fireEvent.error(img)
    expect(screen.getByAltText('Novel').getAttribute('src')?.startsWith('data:image/svg+xml')).toBe(true)
  })
})
