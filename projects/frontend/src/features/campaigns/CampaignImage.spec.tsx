import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CampaignImage from './CampaignImage'

describe('CampaignImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the blob image through the gateway', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ image: 'ipfs://QmImg' }) }))
    render(<CampaignImage metadataUri="ipfs://QmMeta" title="Novel" />)
    const img = await screen.findByAltText('Novel')
    expect(img.getAttribute('src')).toBe('https://ipfs.io/ipfs/QmImg')
  })

  it('renders nothing for blank URIs', () => {
    const { container } = render(<CampaignImage metadataUri="  " title="Novel" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('hides the image when it fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ image: 'https://example.com/cover.jpg' }) }))
    render(<CampaignImage metadataUri="ipfs://QmMeta" title="Novel" />)
    const img = await screen.findByAltText('Novel')
    fireEvent.error(img)
    expect(screen.queryByAltText('Novel')).not.toBeInTheDocument()
  })
})
