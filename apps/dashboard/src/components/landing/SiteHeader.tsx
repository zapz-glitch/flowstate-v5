'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Menu, X, Sun, Moon, ArrowUpRight } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'
import { useTheme } from '@/components/theme-provider'
import { cn } from '@/lib/utils'

const NAV_LINKS = [
  { label: 'What we buy', href: '#what-we-buy' },
  { label: 'Process', href: '#process' },
  { label: 'Who we work with', href: '#network' },
  { label: 'Contact', href: '#contact' },
]

interface SiteHeaderProps {
  onPortalClick: () => void
  isSignedIn?: boolean
}

export function SiteHeader({ onPortalClick, isSignedIn }: SiteHeaderProps) {
  const [open, setOpen] = useState(false)
  const [isScrolled, setIsScrolled] = useState(false)
  const { theme, toggleTheme } = useTheme()

  const isDark = theme === 'night' || theme === 'dawn'

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (!open) return
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = ''
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <header
        className={cn(
          'fixed top-0 left-0 right-0 z-[70] transition-all duration-300',
          open
            ? 'bg-transparent'
            : isScrolled
              ? 'bg-background/80 backdrop-blur-xl border-b border-border'
              : 'bg-transparent'
        )}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between py-4">
            <Link
              href="/"
              className="flex items-center active:scale-[0.98] transition-transform duration-150"
              onClick={() => setOpen(false)}
            >
              <Logo size="md" />
            </Link>

            <div className="flex items-center gap-1">
              <button
                onClick={toggleTheme}
                aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
                className="p-2 text-muted-foreground hover:text-foreground active:scale-90 transition-all duration-150"
              >
                {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
              </button>
              <button
                onClick={() => setOpen((v) => !v)}
                aria-label={open ? 'Close menu' : 'Open menu'}
                aria-expanded={open}
                className="p-2 -mr-2 text-muted-foreground hover:text-foreground active:scale-90 transition-all duration-150"
              >
                {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-[65] bg-background animate-in fade-in duration-150">
          <div className="h-full max-w-6xl mx-auto px-4 sm:px-6 flex flex-col pt-24 pb-8">
            <nav className="flex-1">
              <ul className="space-y-2">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      onClick={() => setOpen(false)}
                      className="block py-2 text-3xl sm:text-4xl font-medium tracking-tight text-foreground transition-all duration-150 hover:text-foreground-secondary hover:translate-x-1 active:scale-[0.99]"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            <button
              onClick={() => { setOpen(false); onPortalClick() }}
              className="w-full sm:w-auto sm:self-start inline-flex items-center justify-center gap-2 py-3 px-6 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150"
            >
              <span>{isSignedIn ? 'Dashboard' : 'Login'}</span>
              <ArrowUpRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
