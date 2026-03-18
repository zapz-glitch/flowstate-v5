'use client'

import { useState } from 'react'
import { Copy, Check, ExternalLink } from 'lucide-react'
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

  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <a
        href={zillowUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:text-primary hover:underline transition-colors"
        onClick={(e) => e.stopPropagation()}
      >
        {address}
      </a>
      <a
        href={zillowUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-foreground-tertiary hover:text-primary transition-colors flex-shrink-0"
        title="View on Zillow"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="w-3 h-3" />
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
  )
}
