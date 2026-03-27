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

  const zillowUrl = `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/`

  // Google Street View URL — use coordinates if available for precise location
  const streetViewUrl = latitude && longitude
    ? `https://www.google.com/maps/@${latitude},${longitude},3a,75y,0h,90t/data=!3m4!1e1!3m2!1s!2e0?entry=ttu`
    : `https://www.google.com/maps/search/${encodeURIComponent(address)}/@?entry=ttu&layer=c`

  return (
    <span className={cn('inline-flex items-center gap-1.5 flex-wrap', className)}>
      <a
        href={zillowUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-primary hover:underline transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        {address}
      </a>
      <button
        type="button"
        onClick={handleCopy}
        className="text-foreground-tertiary hover:text-foreground transition-colors flex-shrink-0"
        title={copied ? 'Copied!' : 'Copy address'}
      >
        {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
      </button>
      {showStreetView && (
        <a
          href={streetViewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          Street View
        </a>
      )}
    </span>
  )
}
