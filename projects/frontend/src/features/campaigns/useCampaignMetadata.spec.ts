import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCampaignMetadata } from './useCampaignMetadata'

describe('useCampaignMetadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the parsed blob', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ description: 'A story' }) }))
    const { result } = renderHook(() => useCampaignMetadata('ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'))
    await waitFor(() => {
      expect(result.current).toEqual({
        name: undefined,
        description: 'A story',
        image: undefined,
        category: undefined,
      })
    })
  })

  it('returns null for blank URIs without fetching', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useCampaignMetadata('  '))
    expect(result.current).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { result } = renderHook(() => useCampaignMetadata('ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'))
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled()
    })
    expect(result.current).toBeNull()
  })

  it('does not update state when unmounted before the load finishes', async () => {
    let resolveFetch: ((value: { ok: boolean; json: () => Promise<unknown> }) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve
        }),
      ),
    )
    const { result, unmount } = renderHook(() => useCampaignMetadata('ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'))
    unmount()

    if (resolveFetch === undefined) throw new Error('fetch was not called')
    resolveFetch({ ok: true, json: () => Promise.resolve({ description: 'A story' }) })
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toBeNull()
  })

  it('does not update state when unmounted before a failed load finishes', async () => {
    let rejectFetch: ((reason: unknown) => void) | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise((_, reject) => {
          rejectFetch = reject
        }),
      ),
    )
    const { result, unmount } = renderHook(() => useCampaignMetadata('ipfs://QmYwAPJzv9CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'))
    unmount()

    if (rejectFetch === undefined) throw new Error('fetch was not called')
    rejectFetch(new Error('offline'))
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toBeNull()
  })
})
