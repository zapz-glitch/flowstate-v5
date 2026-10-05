'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AddressDisplayProps {
  address: string
  latitude?: number | null
  longitude?: number | null
  className?: string
  /** Show Street View link (default: true) */
  showStreetView?: boolean
}

export function AddressDisplay({ address, latitude, longitude, className, showStreetView = true }: AddressDisplayProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Google Street View URL — use coordinates if available for precise location
  const streetViewUrl = latitude && longitude
    ? `https://www.google.com/maps/@${latitude},${longitude},3a,75y,0h,90t/data=!3m4!1e1!3m2!1s!2e0?entry=ttu`
    : `https://www.google.com/maps/search/${encodeURIComponent(address)}/@?entry=ttu&layer=c`

  return (
    <span className={cn(className)}>
      <span>
        {/* Plain text — no outbound link; the card owns its clicks */}
        <span>{formatAddressCasing(address)}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex align-middle ml-1.5 text-foreground-tertiary hover:text-foreground transition-colors"
          title={copied ? 'Copied!' : 'Copy address'}
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
        </button>
      </span>
      {showStreetView && (
        <a
          href={streetViewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-foreground-tertiary hover:text-foreground hover:bg-muted/70 transition-colors align-middle"
          onClick={(e) => e.stopPropagation()}
        >
          Street View
        </a>
      )}
    </span>
  )
}

/** "1643 Bagpipe Pl, CONLEY, GA 30288" → "1643 Bagpipe Pl, Conley, GA 30288" —
 *  title-cases every word except 2-letter state codes and numbers. */
function formatAddressCasing(address: string): string {
  return address
    .split(',')
    .map((part) =>
      part
        .trim()
        .split(/\s+/)
        .map((word) =>
          /^[A-Z]{2}$/.test(word) || /\d/.test(word)
            ? word.toUpperCase()
            : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        )
        .join(' ')
    )
    .join(', ')
}
