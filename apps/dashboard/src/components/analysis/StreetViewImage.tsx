'use client'

import { useState } from 'react'
import { Home } from 'lucide-react'

interface StreetViewImageProps {
  photos?: string[]
  address?: string
  latitude?: number | null
  longitude?: number | null
  width?: number
  height?: number
  className?: string
}

/** Static insignia shown while checking coverage or when no imagery exists */
function ImageInsignia({ className, loading }: { className?: string; loading?: boolean }) {
  return (
    <div
      className={className ?? 'w-full h-auto'}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100%' }}
      aria-label={loading ? 'Loading imagery' : 'No imagery available'}
    >
      <div
        className={loading ? 'animate-pulse' : undefined}
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <Home className="w-5 h-5" style={{ color: 'rgba(255,255,255,0.35)' }} />
      </div>
    </div>
  )
}

export function StreetViewImage(props: StreetViewImageProps) {
  const streetViewSrc = getStreetViewUrl({ ...props, width: props.width ?? 640, height: props.height ?? 480 })
  // Reset image failures when a card is reused for another property.
  return <PropertyImage key={streetViewSrc ?? props.address ?? ''} {...props} streetViewSrc={streetViewSrc} />
}

function PropertyImage({ photos, address, className, streetViewSrc }: StreetViewImageProps & { streetViewSrc: string | null }) {
  const [failedSources, setFailedSources] = useState<string[]>([])
  const streetView = streetViewSrc && !failedSources.includes(streetViewSrc) ? streetViewSrc : null
  const photo = photos?.find(url => /^\/user\/reports\/[a-zA-Z0-9_-]+\/assets\/[a-f0-9-]{36}$/.test(url) && !failedSources.includes(url))
  const src = streetView ?? photo
  if (!src) return <ImageInsignia className={className} />

  return (
    <img
      key={src}
      src={src}
      alt={streetView ? `Google Street View${address ? `: ${address}` : ''}` : `Saved property photo${address ? `: ${address}` : ''}`}
      className={className ?? 'w-full h-auto'}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSources(previous => [...previous, src])}
    />
  )
}

/**
 * Generates a Street View Static API URL for use as a thumbnail.
 * Returns null if no key is configured. Missing coverage returns an HTTP error
 * so the image fallback works without a separate metadata request.
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

  const location = opts.latitude != null && opts.longitude != null && Number.isFinite(opts.latitude) && Number.isFinite(opts.longitude)
    ? `${opts.latitude},${opts.longitude}`
    : opts.address
      ? encodeURIComponent(opts.address)
      : null

  if (!location) return null

  const w = opts.width ?? 400
  const h = opts.height ?? 300
  return `https://maps.googleapis.com/maps/api/streetview?location=${location}&size=${w}x${h}&key=${key}&source=outdoor&return_error_code=true`
}
