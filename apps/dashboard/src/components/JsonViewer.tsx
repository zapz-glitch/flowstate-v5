'use client'

import { useState } from 'react'
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react'

interface JsonViewerProps {
  title: string
  data: string | null
  defaultCollapsed?: boolean
  maxHeight?: string
}

export function JsonViewer({
  title,
  data,
  defaultCollapsed = false,
  maxHeight = '400px',
}: JsonViewerProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (!data) return
    try {
      await navigator.clipboard.writeText(data)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API not available
    }
  }

  // Format JSON for display
  let formattedContent: string
  let isValidJson = false

  if (!data) {
    formattedContent = 'No data'
  } else {
    try {
      const parsed = JSON.parse(data)
      formattedContent = JSON.stringify(parsed, null, 2)
      isValidJson = true
    } catch {
      formattedContent = data
    }
  }

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-neutral-50 dark:bg-neutral-800/50 border-b border-neutral-200 dark:border-neutral-800">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center gap-2 text-sm font-medium text-neutral-900 dark:text-white hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <ChevronDown className="w-4 h-4" />
          )}
          {title}
        </button>
        {data && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded transition-colors"
            title="Copy to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-500" />
                Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                Copy
              </>
            )}
          </button>
        )}
      </div>

      {/* Content */}
      {!collapsed && (
        <div
          className="overflow-auto bg-neutral-50 dark:bg-neutral-950"
          style={{ maxHeight }}
        >
          {!data ? (
            <div className="p-4 text-sm text-neutral-500 italic">
              No data available
            </div>
          ) : (
            <pre className="p-4 text-sm font-mono text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap break-words">
              {isValidJson ? (
                <JsonSyntaxHighlight json={formattedContent} />
              ) : (
                formattedContent
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

// Simple JSON syntax highlighting
function JsonSyntaxHighlight({ json }: { json: string }) {
  // Split into lines for line-by-line processing
  const lines = json.split('\n')

  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="leading-relaxed">
          {highlightLine(line)}
        </div>
      ))}
    </>
  )
}

function highlightLine(line: string): React.ReactNode {
  // Match different JSON tokens
  const tokens: React.ReactNode[] = []
  let remaining = line
  let key = 0

  while (remaining.length > 0) {
    // Match key (string followed by colon)
    const keyMatch = remaining.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)/)
    if (keyMatch) {
      tokens.push(<span key={key++}>{keyMatch[1]}</span>)
      tokens.push(
        <span key={key++} className="text-foreground">
          {keyMatch[2]}
        </span>
      )
      tokens.push(<span key={key++}>{keyMatch[3]}</span>)
      remaining = remaining.slice(keyMatch[0].length)
      continue
    }

    // Match string value
    const stringMatch = remaining.match(/^("(?:[^"\\]|\\.)*")/)
    if (stringMatch) {
      tokens.push(
        <span key={key++} className="text-green-600 dark:text-green-400">
          {stringMatch[1]}
        </span>
      )
      remaining = remaining.slice(stringMatch[0].length)
      continue
    }

    // Match number
    const numberMatch = remaining.match(/^(-?\d+\.?\d*(?:[eE][+-]?\d+)?)/)
    if (numberMatch) {
      tokens.push(
        <span key={key++} className="text-blue-600 dark:text-blue-400">
          {numberMatch[1]}
        </span>
      )
      remaining = remaining.slice(numberMatch[0].length)
      continue
    }

    // Match boolean/null
    const boolMatch = remaining.match(/^(true|false|null)/)
    if (boolMatch) {
      tokens.push(
        <span key={key++} className="text-orange-600 dark:text-orange-400">
          {boolMatch[1]}
        </span>
      )
      remaining = remaining.slice(boolMatch[0].length)
      continue
    }

    // Match brackets/braces
    const bracketMatch = remaining.match(/^([\[\]{}])/)
    if (bracketMatch) {
      tokens.push(
        <span key={key++} className="text-neutral-500">
          {bracketMatch[1]}
        </span>
      )
      remaining = remaining.slice(1)
      continue
    }

    // Match comma
    if (remaining[0] === ',') {
      tokens.push(
        <span key={key++} className="text-neutral-500">
          ,
        </span>
      )
      remaining = remaining.slice(1)
      continue
    }

    // Match whitespace
    const wsMatch = remaining.match(/^(\s+)/)
    if (wsMatch) {
      tokens.push(<span key={key++}>{wsMatch[1]}</span>)
      remaining = remaining.slice(wsMatch[0].length)
      continue
    }

    // Fallback: take one character
    tokens.push(<span key={key++}>{remaining[0]}</span>)
    remaining = remaining.slice(1)
  }

  return <>{tokens}</>
}
