'use client'

import { cn } from '@/lib/utils'

interface LogoProps {
  className?: string
  showText?: boolean
  size?: 'sm' | 'md' | 'lg'
}

// Flow mark: infinity loop carrying two network nodes — deal flow,
// distribution network, and the flywheel in a single stroke
function FlowGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 12 C9.5 9.5 7.5 8 5.8 8 C3.6 8 2.2 9.8 2.2 12 C2.2 14.2 3.6 16 5.8 16 C7.5 16 9.5 14.5 12 12 C14.5 14.5 16.5 16 18.2 16 C20.4 16 21.8 14.2 21.8 12 C21.8 9.8 20.4 8 18.2 8 C16.5 8 14.5 9.5 12 12 Z" />
      <circle cx="6.6" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="17.4" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function Logo({ className, showText = true, size = 'md' }: LogoProps) {
  const sizes = {
    sm: { icon: 'w-7 h-7', text: 'text-base', svg: 'w-4 h-4' },
    md: { icon: 'w-8 h-8', text: 'text-lg', svg: 'w-5 h-5' },
    lg: { icon: 'w-10 h-10', text: 'text-xl', svg: 'w-6 h-6' },
  }

  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      {/* Flowstate mark - inverted monochrome */}
      <div className={cn(
        'rounded-md bg-foreground flex items-center justify-center',
        sizes[size].icon
      )}>
        <FlowGlyph className={cn('text-background', sizes[size].svg)} />
      </div>
      {showText && (
        <span className={cn('font-semibold tracking-tight text-foreground', sizes[size].text)}>
          flowstate
        </span>
      )}
    </div>
  )
}

export function LogoIcon({ className }: { className?: string }) {
  return (
    <div className={cn(
      'w-8 h-8 rounded-md bg-foreground flex items-center justify-center',
      className
    )}>
      <FlowGlyph className="w-5 h-5 text-background" />
    </div>
  )
}
