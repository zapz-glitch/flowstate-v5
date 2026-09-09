'use client'

import { useState } from 'react'
import { ImageOff } from 'lucide-react'

interface StreetViewImageProps {
  photos?: string[]
  address?: string
  latitude?: number | null
  longitude?: number | null
  width?: number
  height?: number
  className?: string
}

export function StreetViewImage({
  photos,
  address,
  latitude,
  longitude,
  width = 640,
  height = 480,
  className,
}: StreetViewImageProps) {
  const [error, setError] = useState(false)
  const [failedPhotos, setFailedPhotos] = useState<string[]>([])
  const photo = photos?.find(url => /^\/user\/reports\/[a-zA-Z0-9_-]+\/assets\/[a-f0-9-]{36}$/.test(url) && !failedPhotos.includes(url))
  if (photo) return <img src={photo} alt={address ? `Saved property photo: ${address}` : 'Saved property photo'} className={className ?? 'w-full h-auto'} loading="lazy" onError={() => setFailedPhotos(previous => [...previous, photo])} />
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAP_KEY
  if (!key || error) return null

  const location = latitude && longitude
    ? `${latitude},${longitude}`
    : address
      ? encodeURIComponent(address)
      : null

  if (!location) return null

  const src = `https://maps.googleapis.com/maps/api/streetview?location=${location}&size=${width}x${height}&key=${key}&source=outdoor`

  return (
    <img
      src={src}
      alt="Street view"
      className={className ?? 'w-full h-auto'}
      loading="lazy"
      onError={() => setError(true)}
    />
  )
}

/**
 * Generates a Street View Static API URL for use as a thumbnail.
 * Returns null if no key is configured.
 */
export function getStreetViewUrl(opts: {
  address?: string
  latitude?: number | null
  longitude?: number | null
  width?: number
  height?: number
}): string | null {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAP_KEY
  if (!key) return null

  const location = opts.latitude && opts.longitude
    ? `${opts.latitude},${opts.longitude}`
    : opts.address
      ? encodeURIComponent(opts.address)
      : null

  if (!location) return null

  const w = opts.width ?? 400
  const h = opts.height ?? 300
  return `https://maps.googleapis.com/maps/api/streetview?location=${location}&size=${w}x${h}&key=${key}&source=outdoor`
}
