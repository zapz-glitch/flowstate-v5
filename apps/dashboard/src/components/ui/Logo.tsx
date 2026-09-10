'use client'

import { cn } from '@/lib/utils'

interface LogoProps {
  className?: string
  showText?: boolean
  size?: 'sm' | 'md' | 'lg'
}

// Flow mark: a continuous lemniscate whose lobes peak into house roofs —
// infinity + flow + homes in a single stroke
function FlowGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 12 L6.9 5.3 L3 10.3 C1.7 12.5 3.6 15.5 6.4 15.9 C9.1 16.3 11 14.2 12 12 C13 14.2 14.9 16.3 17.6 15.9 C20.4 15.5 22.3 12.5 21 10.3 L17.1 5.3 Z" />
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
