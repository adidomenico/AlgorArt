import { useState } from 'react'
import { resolveImageSrc } from '../../lib/metadata'
import { useCampaignMetadata } from './useCampaignMetadata'

interface CampaignImageProps {
  metadataUri: string
  title: string
  className?: string
}

const FALLBACK_SRC = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="#e2e8f0"/><g fill="none" stroke="#4a5568" stroke-width="14" opacity="0.6"><rect x="344" y="172" width="112" height="106" rx="12"/><circle cx="376" cy="206" r="9" fill="#4a5568" stroke="none"/><path d="M344 254l30-30 22 22 28-28 32 32v28H344z" fill="#4a5568" stroke="none"/></g></svg>',
)}`

/**
 * Campaign cover from the metadata blob. Always renders the same element so
 * cards keep a consistent height, falling back to a placeholder when the
 * image is missing or broken.
 *
 * @param root0 Component props.
 * @param root0.metadataUri On-chain metadata pointer.
 * @param root0.title Alt text for the image.
 * @param root0.className Optional Tailwind classes for the image.
 * @returns The cover image, or the placeholder fallback.
 */
const CampaignImage = ({ metadataUri, title, className }: CampaignImageProps) => {
  const metadata = useCampaignMetadata(metadataUri)
  const [broken, setBroken] = useState(false)

  const src = resolveImageSrc(metadataUri, metadata)
  const displaySrc = broken || src === null ? FALLBACK_SRC : src

  return (
    <img
      src={displaySrc}
      alt={title}
      loading="lazy"
      className={className}
      onError={() => {
        setBroken(true)
      }}
    />
  )
}

export default CampaignImage
