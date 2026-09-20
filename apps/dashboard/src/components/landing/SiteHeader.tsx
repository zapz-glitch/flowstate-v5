'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Menu } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

const NAV_LINKS = [
  { label: 'What we buy', href: '#what-we-buy' },
  { label: 'Process', href: '#process' },
  { label: 'Who we work with', href: '#network' },
  { label: 'Contact', href: '#contact' },
]

export function SiteHeader() {
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

  return (
    <header
      className={cn(
        'fixed top-0 left-0 right-0 z-[70] transition-all duration-300 pt-[var(--sat)]',
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

          <Sheet>
            <SheetTrigger asChild>
              <button
                aria-label="Open menu"
                className="flex items-center justify-center h-10 w-10 -mr-2 text-muted-foreground hover:text-foreground active:scale-[0.94] transition-all duration-150"
              >
                <Menu className="h-5 w-5" />
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 sm:w-80">
              <SheetTitle className="mono-label">Menu</SheetTitle>
              <nav className="flex flex-col mt-8">
                {NAV_LINKS.map((link) => (
                  <SheetClose asChild key={link.href}>
                    <Link
                      href={link.href}
                      className={cn(
                        'py-4 text-lg font-medium border-b border-border/60 transition-colors duration-150',
                        activeId === link.href
                          ? 'text-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {link.label}
                    </Link>
                  </SheetClose>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
