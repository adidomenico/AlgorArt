import { useEffect, useState } from 'react'
import type { CampaignMetadata } from '../../lib/metadata'
import { fetchCampaignMetadata } from '../../lib/metadata'

/**
 * Load the off-chain metadata blob for a `metadataUri`; null while blank/failed.
 *
 * @param metadataUri The `metadataUri` pointer.
 * @returns The parsed metadata, or null.
 */
export function useCampaignMetadata(metadataUri: string): CampaignMetadata | null {
  const [metadata, setMetadata] = useState<CampaignMetadata | null>(null)

  useEffect(() => {
    if (metadataUri.trim() === '') {
      setMetadata(null)
      return
    }
    let cancelled = false
    // fetchCampaignMetadata resolves null on every failure path, so no catch is needed.
    void fetchCampaignMetadata(metadataUri).then((result) => {
      if (!cancelled) setMetadata(result)
    })
    return () => {
      cancelled = true
    }
  }, [metadataUri])

  return metadata
}
