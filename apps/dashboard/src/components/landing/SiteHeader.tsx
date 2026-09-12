'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Sun, Moon, ArrowUpRight } from 'lucide-react'
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
  const [isScrolled, setIsScrolled] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const { theme, toggleTheme } = useTheme()

  const isDark = theme === 'night' || theme === 'dawn'

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // Scroll-spy: highlight the section currently in view
  useEffect(() => {
    const sections = NAV_LINKS
      .map((l) => document.getElementById(l.href.slice(1)))
      .filter((el): el is HTMLElement => el !== null)
    if (sections.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(`#${entry.target.id}`)
        }
      },
      { rootMargin: '-35% 0px -60% 0px' }
    )
    sections.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  const linkClass = (href: string, base: string) =>
    cn(
      base,
      'transition-all duration-150 active:scale-[0.97] whitespace-nowrap',
      activeId === href
        ? 'text-foreground'
        : 'text-muted-foreground hover:text-foreground'
    )

  return (
    <header
      className={cn(
        'fixed top-0 left-0 right-0 z-[70] transition-all duration-300',
        isScrolled
          ? 'bg-background/80 backdrop-blur-xl border-b border-border'
          : 'bg-transparent'
      )}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between gap-6 py-4">
          <Link
            href="/"
            className="flex items-center shrink-0 active:scale-[0.98] transition-transform duration-150"
          >
            <Logo size="md" />
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-7 flex-1 justify-center">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={linkClass(link.href, 'text-sm')}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={toggleTheme}
              aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
              className="p-2 text-muted-foreground hover:text-foreground active:scale-90 transition-all duration-150"
            >
              {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            <button
              onClick={onPortalClick}
              className="inline-flex items-center gap-1.5 py-2 px-4 bg-foreground text-background text-sm font-medium rounded-full hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150"
            >
              <span>{isSignedIn ? 'Dashboard' : 'Login'}</span>
              <ArrowUpRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Mobile nav row */}
        <nav className="md:hidden flex items-center gap-5 pb-3 -mt-1 overflow-x-auto">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={linkClass(link.href, 'mono-label !text-[10px]')}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  )
}
