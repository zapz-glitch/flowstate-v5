'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
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

          <button
            onClick={onPortalClick}
            className="text-sm text-muted-foreground hover:text-foreground active:scale-[0.97] transition-all duration-150 whitespace-nowrap shrink-0"
          >
            <span className="underline underline-offset-4">{isSignedIn ? 'Dashboard' : 'Login'}</span>
          </button>
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
