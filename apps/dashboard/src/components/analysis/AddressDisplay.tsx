'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface AddressDisplayProps {
  address: string
  className?: string
}

export function AddressDisplay({ address, className }: AddressDisplayProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const zillowUrl = `https://www.zillow.com/homes/${encodeURIComponent(address)}_rb/`
  const streetViewUrl = `https://www.google.com/maps/search/${encodeURIComponent(address)}/@?entry=ttu&layer=c`

  return (
    <span className={cn('inline-flex flex-col gap-1', className)}>
      {/* Address (Zillow link) + copy */}
      <span className="inline-flex items-center gap-1.5">
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
      </span>
      {/* Street View link */}
      <a
        href={streetViewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors w-fit"
        onClick={(e) => e.stopPropagation()}
      >
        Street View
      </a>
    </span>
  )
}
