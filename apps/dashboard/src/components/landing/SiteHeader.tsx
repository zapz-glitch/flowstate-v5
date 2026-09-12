'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Menu, Moon, Sunrise, Sun, Lightbulb, ArrowUpRight } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { useTheme, type Theme } from '@/components/theme-provider'
import { cn } from '@/lib/utils'

const NAV_LINKS = [
  { index: '01', label: 'What we buy', href: '#what-we-buy' },
  { index: '02', label: 'Process', href: '#process' },
  { index: '03', label: 'Who we work with', href: '#network' },
  { index: '04', label: 'Contact', href: '#contact' },
]

const THEME_PRESETS: { id: Theme; label: string; icon: typeof Moon }[] = [
  { id: 'night', label: 'Night', icon: Moon },
  { id: 'dawn', label: 'Early morning', icon: Sunrise },
  { id: 'outdoor', label: 'Outdoor', icon: Sun },
  { id: 'led', label: 'Bright indoor', icon: Lightbulb },
]

interface SiteHeaderProps {
  onPortalClick: () => void
  isSignedIn?: boolean
}

export function SiteHeader({ onPortalClick, isSignedIn }: SiteHeaderProps) {
  const [open, setOpen] = useState(false)
  const [isScrolled, setIsScrolled] = useState(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return (
    <header
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transition-all duration-300',
        isScrolled
          ? 'bg-background/80 backdrop-blur-xl border-b border-border'
          : 'bg-transparent'
      )}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between py-4">
          <Link href="/" className="flex items-center" onClick={() => setOpen(false)}>
            <Logo size="md" />
          </Link>

          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors p-2 -mr-2"
          >
            <span className="mono-label hidden sm:inline">Menu</span>
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-sm bg-background border-l border-border p-0 flex flex-col">
          <SheetHeader className="px-6 pt-6 pb-4 border-b border-border">
            <SheetTitle className="mono-label !text-[10px]">Flowstate</SheetTitle>
            <SheetDescription className="sr-only">Site menu</SheetDescription>
          </SheetHeader>

          <nav className="px-6 py-6 border-b border-border">
            <p className="mono-label !text-[10px] mb-4">Navigate</p>
            <ul className="space-y-1">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="group flex items-baseline gap-3 py-2 text-foreground hover:text-foreground-secondary transition-colors"
                  >
                    <span className="mono-label !text-[10px]">{link.index}</span>
                    <span className="text-xl font-medium tracking-tight">{link.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="px-6 py-6 border-b border-border">
            <p className="mono-label !text-[10px] mb-4">Environment</p>
            <div className="grid grid-cols-2 gap-2">
              {THEME_PRESETS.map((preset) => {
                const Icon = preset.icon
                const active = theme === preset.id
                return (
                  <button
                    key={preset.id}
                    onClick={() => setTheme(preset.id)}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2.5 rounded-md border text-sm transition-colors text-left',
                      active
                        ? 'border-foreground/40 bg-secondary text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{preset.label}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="px-6 py-6 mt-auto">
            <p className="mono-label !text-[10px] mb-4">Access</p>
            <button
              onClick={() => { setOpen(false); onPortalClick() }}
              className="w-full flex items-center justify-between py-3 px-4 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 transition-colors"
            >
              <span>{isSignedIn ? 'Open dashboard' : 'Investor portal'}</span>
              <ArrowUpRight className="h-4 w-4" />
            </button>
            <p className="text-xs text-muted-foreground/70 mt-3">
              {isSignedIn
                ? 'You are signed in.'
                : 'Sign in to access the underwriting dashboard.'}
            </p>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  )
}
