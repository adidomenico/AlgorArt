import { useState } from 'react'
import { resolveImageSrc } from '../../lib/metadata'
import { useCampaignMetadata } from './useCampaignMetadata'

interface CampaignImageProps {
  metadataUri: string
  title: string
  className?: string
}

/**
 * Campaign cover from the metadata blob; renders nothing until it loads.
 *
 * @param root0 Component props.
 * @param root0.metadataUri On-chain metadata pointer.
 * @param root0.title Alt text for the image.
 * @param root0.className Optional Tailwind classes for the image.
 * @returns The cover image, or null while loading, missing, or broken.
 */
const CampaignImage = ({ metadataUri, title, className }: CampaignImageProps) => {
  const metadata = useCampaignMetadata(metadataUri)
  const [broken, setBroken] = useState(false)

  const src = resolveImageSrc(metadataUri, metadata)
  if (src === null || broken) return null

  return (
    <img
      src={src}
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
