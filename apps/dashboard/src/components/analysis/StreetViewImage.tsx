'use client'

import { useEffect, useState } from 'react'
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
  const [coverage, setCoverage] = useState<'checking' | 'ok' | 'none'>('checking')

  const photo = photos?.find(url => /^\/user\/reports\/[a-zA-Z0-9_-]+\/assets\/[a-f0-9-]{36}$/.test(url) && !failedPhotos.includes(url))
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAP_KEY
  const location = latitude && longitude
    ? `${latitude},${longitude}`
    : address
      ? encodeURIComponent(address)
      : null

  // Check coverage via the metadata endpoint — Street View returns a
  // "Sorry, we have no imagery here" image with HTTP 200 when there's no
  // coverage, so the metadata status is the only reliable signal.
  useEffect(() => {
    if (photo || !key || !location) {
      setCoverage('none')
      return
    }
    let cancelled = false
    fetch(`https://maps.googleapis.com/maps/api/streetview/metadata?location=${location}&source=outdoor&key=${key}`)
      .then((r) => r.json() as Promise<{ status?: string }>)
      .then((d) => { if (!cancelled) setCoverage(d.status === 'OK' ? 'ok' : 'none') })
      .catch(() => { if (!cancelled) setCoverage('ok') }) // fail-open: try the image
    return () => { cancelled = true }
  }, [photo, key, location])

  if (photo) return <img src={photo} alt={address ? `Saved property photo: ${address}` : 'Saved property photo'} className={className ?? 'w-full h-auto'} loading="lazy" onError={() => setFailedPhotos(previous => [...previous, photo])} />
  if (!key || error || !location) return <ImageInsignia className={className} />
  if (coverage === 'checking') return <ImageInsignia className={className} loading />
  if (coverage === 'none') return <ImageInsignia className={className} />

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
