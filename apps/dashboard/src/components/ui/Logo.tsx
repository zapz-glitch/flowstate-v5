'use client'

import { cn } from '@/lib/utils'

interface LogoProps {
  className?: string
  showText?: boolean
  size?: 'sm' | 'md' | 'lg'
}

// Flow mark: house outline whose base dissolves into a wave — home + flow
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
      <path d="M4.5 17.5 V10.8 L12 4.5 L19.5 10.8 V17.5 M4.5 17.5 C7 17.5 8 15.5 10.5 15.5 C13 15.5 14 17.5 16.5 17.5 C17.8 17.5 19 17 19.5 16.3" />
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
