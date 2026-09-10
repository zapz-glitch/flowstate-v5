'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

interface TerminalProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string
}

const Terminal = React.forwardRef<HTMLDivElement, TerminalProps>(
  ({ className, title = 'Terminal', children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-xl border border-border bg-secondary dark:bg-zinc-950 overflow-hidden shadow-xl',
          className
        )}
        {...props}
      >
        {/* Terminal header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-muted dark:bg-zinc-900 border-b border-border dark:border-zinc-800">
          <div className="flex gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
          </div>
          <span className="ml-2 text-xs text-muted-foreground font-mono">{title}</span>
        </div>
        {/* Terminal content */}
        <div className="p-4 font-mono text-sm overflow-auto max-h-[600px] text-foreground dark:text-zinc-300">
          {children}
        </div>
      </div>
    )
  }
)
Terminal.displayName = 'Terminal'

interface TerminalLineProps {
  type?: 'command' | 'output' | 'error' | 'success' | 'info' | 'step'
  prefix?: string
  children: React.ReactNode
  animate?: boolean
  delay?: number
}

function TerminalLine({
  type = 'output',
  prefix,
  children,
  animate = false,
  delay = 0
}: TerminalLineProps) {
  const [visible, setVisible] = React.useState(!animate)

  React.useEffect(() => {
    if (animate) {
      const timer = setTimeout(() => setVisible(true), delay)
      return () => clearTimeout(timer)
    }
  }, [animate, delay])

  if (!visible) return null

  const prefixColors = {
    command: 'text-emerald-600 dark:text-emerald-400',
    output: 'text-muted-foreground',
    error: 'text-red-600 dark:text-red-400',
    success: 'text-emerald-600 dark:text-emerald-400',
    info: 'text-blue-600 dark:text-blue-400',
    step: 'text-foreground-secondary',
  }

  const defaultPrefixes = {
    command: '$ ',
    output: '',
    error: '✗ ',
    success: '✓ ',
    info: 'ℹ ',
    step: '→ ',
  }

  return (
    <div
      className={cn(
        'flex gap-2',
        animate && 'animate-fade-in'
      )}
    >
      <span className={prefixColors[type]}>
        {prefix ?? defaultPrefixes[type]}
      </span>
      <span className={cn(
        type === 'error' && 'text-red-600 dark:text-red-400',
        type === 'success' && 'text-emerald-600 dark:text-emerald-400',
        type === 'info' && 'text-blue-600 dark:text-blue-400',
        type === 'step' && 'text-foreground-secondary',
        type === 'output' && 'text-foreground dark:text-zinc-300',
        type === 'command' && 'text-foreground dark:text-zinc-100'
      )}>
        {children}
      </span>
    </div>
  )
}

interface TerminalJsonProps {
  data: unknown
  animate?: boolean
  delay?: number
  collapsed?: boolean
}

function TerminalJson({ data, animate = false, delay = 0, collapsed = false }: TerminalJsonProps) {
  const [visible, setVisible] = React.useState(!animate)
  const [isExpanded, setIsExpanded] = React.useState(!collapsed)

  React.useEffect(() => {
    if (animate) {
      const timer = setTimeout(() => setVisible(true), delay)
      return () => clearTimeout(timer)
    }
  }, [animate, delay])

  if (!visible) return null

  const jsonString = JSON.stringify(data, null, 2)
  const lines = jsonString.split('\n')
  const previewLines = lines.slice(0, 5)

  if (collapsed && !isExpanded) {
    return (
      <div className={cn('mt-2', animate && 'animate-fade-in')}>
        <pre className="text-foreground dark:text-zinc-300 text-xs leading-relaxed">
          {previewLines.join('\n')}
          {lines.length > 5 && (
            <span className="text-muted-foreground">
              {'\n  ...'}
            </span>
          )}
        </pre>
        {lines.length > 5 && (
          <button
            onClick={() => setIsExpanded(true)}
            className="mt-2 text-xs text-foreground-secondary hover:text-foreground transition-colors"
          >
            Show all ({lines.length} lines)
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={cn('mt-2', animate && 'animate-fade-in')}>
      <pre className="text-foreground dark:text-zinc-300 text-xs leading-relaxed whitespace-pre-wrap">
        {highlightJson(jsonString)}
      </pre>
      {collapsed && isExpanded && (
        <button
          onClick={() => setIsExpanded(false)}
          className="mt-2 text-xs text-foreground-secondary hover:text-foreground transition-colors"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

function highlightJson(json: string): React.ReactNode {
  // Simple syntax highlighting for JSON
  const parts: React.ReactNode[] = []
  let key = 0

  // Match strings, numbers, booleans, null
  const regex = /("(?:[^"\\]|\\.)*")\s*:/g
  const valueRegex = /:\s*("(?:[^"\\]|\\.)*"|true|false|null|-?\d+\.?\d*)/g

  let lastIndex = 0
  let match

  // Highlight keys
  const withKeys = json.replace(/"([^"]+)":/g, (_, p1) => `<key>"${p1}"</key>:`)

  // Highlight values
  const withValues = withKeys
    .replace(/:\s*"([^"]*)"([,\n\r}])/g, ': <string>"$1"</string>$2')
    .replace(/:\s*(true|false)/g, ': <bool>$1</bool>')
    .replace(/:\s*(null)/g, ': <null>$1</null>')
    .replace(/:\s*(-?\d+\.?\d*)/g, ': <number>$1</number>')

  // Parse and render
  const elements: React.ReactNode[] = []
  let current = ''
  let inTag = false
  let tagName = ''

  for (let i = 0; i < withValues.length; i++) {
    const char = withValues[i]

    if (char === '<' && !inTag) {
      if (current) {
        elements.push(<span key={key++}>{current}</span>)
        current = ''
      }
      inTag = true
      tagName = ''
    } else if (char === '>' && inTag) {
      inTag = false
      if (tagName.startsWith('/')) {
        // Closing tag - already handled
      } else {
        // Opening tag - find content until closing tag
        const closeTag = `</${tagName}>`
        const closeIndex = withValues.indexOf(closeTag, i + 1)
        if (closeIndex !== -1) {
          const content = withValues.slice(i + 1, closeIndex)
          const colorClass = {
            key: 'text-foreground',
            string: 'text-green-600 dark:text-green-400',
            number: 'text-blue-600 dark:text-blue-400',
            bool: 'text-yellow-600 dark:text-yellow-400',
            null: 'text-red-600 dark:text-red-400',
          }[tagName] || ''
          elements.push(<span key={key++} className={colorClass}>{content}</span>)
          i = closeIndex + closeTag.length - 1
        }
      }
    } else if (inTag) {
      tagName += char
    } else {
      current += char
    }
  }

  if (current) {
    elements.push(<span key={key++}>{current}</span>)
  }

  return elements
}

interface TerminalSpinnerProps {
  text?: string
}

function TerminalSpinner({ text = 'Loading...' }: TerminalSpinnerProps) {
  const [dots, setDots] = React.useState('')

  React.useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.')
    }, 400)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex items-center gap-2 text-foreground-secondary">
      <span className="animate-spin">⠋</span>
      <span>{text}{dots}</span>
    </div>
  )
}

interface TerminalProgressProps {
  label: string
  progress: number
  total?: number
}

function TerminalProgress({ label, progress, total = 100 }: TerminalProgressProps) {
  const percentage = Math.round((progress / total) * 100)
  const barLength = 30
  const filled = Math.round((progress / total) * barLength)
  const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled)

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-muted-foreground min-w-[120px]">{label}</span>
      <span className="text-foreground font-mono">[{bar}]</span>
      <span className="text-muted-foreground/70">{percentage}%</span>
    </div>
  )
}

export {
  Terminal,
  TerminalLine,
  TerminalJson,
  TerminalSpinner,
  TerminalProgress
}
