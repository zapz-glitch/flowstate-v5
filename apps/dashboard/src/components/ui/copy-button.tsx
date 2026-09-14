'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CopyButtonProps {
  text: string
  className?: string
  title?: string
}

export function CopyButton({ text, className, title }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  if (!text) return null

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn('inline-flex align-middle text-foreground-tertiary hover:text-foreground transition-colors', className)}
      title={copied ? 'Copied!' : (title ?? 'Copy')}
    >
      {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}
