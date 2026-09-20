'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'
import { cn } from '@/lib/utils'

const NAV_LINKS = [
  { index: '01', label: 'What we buy', href: '#what-we-buy' },
  { index: '02', label: 'Process', href: '#process' },
  { index: '03', label: 'Who we work with', href: '#network' },
  { index: '04', label: 'Contact', href: '#contact' },
]

export function SiteHeader() {
  const [isScrolled, setIsScrolled] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

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

  // Lock scroll + close on Escape while the menu is open
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <header
        className={cn(
          'fixed top-0 left-0 right-0 z-[70] transition-colors duration-300 pt-[var(--sat)]',
          open || isScrolled
            ? 'bg-background/90 backdrop-blur-xl border-b border-border'
            : 'bg-transparent'
        )}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6">
          <div className="flex items-center justify-between gap-6 py-4">
            <Link
              href="/"
              onClick={() => setOpen(false)}
              className="flex items-center shrink-0 active:scale-[0.98] transition-transform duration-150"
            >
              <Logo size="md" />
            </Link>

            <button
              type="button"
              aria-label={open ? 'Close menu' : 'Open menu'}
              aria-expanded={open}
              aria-controls="site-menu"
              onClick={() => setOpen((v) => !v)}
              className="group flex items-center gap-3 -mr-1 py-2 pl-3 text-muted-foreground hover:text-foreground transition-colors duration-150"
            >
              <span className="mono-label !text-[10px] hidden sm:inline transition-colors group-hover:text-foreground">
                {open ? 'Close' : 'Menu'}
              </span>
              <span className="relative block h-3 w-5" aria-hidden>
                <span
                  className={cn(
                    'absolute left-0 top-0 h-px w-full bg-current transition-transform duration-300 ease-out',
                    open && 'translate-y-[5.5px] rotate-45'
                  )}
                />
                <span
                  className={cn(
                    'absolute left-0 bottom-0 h-px w-full bg-current transition-transform duration-300 ease-out',
                    open && '-translate-y-[5.5px] -rotate-45'
                  )}
                />
              </span>
            </button>
          </div>
        </div>
      </header>

      {/* Full-bleed menu panel — drops beneath the header, same grid + hairline grammar as the page */}
      <div
        id="site-menu"
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        className={cn(
          'fixed inset-0 z-[60] flex flex-col bg-background transition-opacity duration-300',
          open ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
      >
        {/* spacer for header height */}
        <div className="h-[calc(var(--sat)+4.5rem)] shrink-0" />

        <nav className="flex-1 overflow-y-auto">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-6 sm:pt-10">
            <ul className="border-t border-border">
              {NAV_LINKS.map((link, i) => {
                const active = activeId === link.href
                return (
                  <li
                    key={link.href}
                    className={cn(
                      'border-b border-border transition-all duration-500 ease-out',
                      open ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
                    )}
                    style={{ transitionDelay: open ? `${80 + i * 50}ms` : '0ms' }}
                  >
                    <Link
                      href={link.href}
                      onClick={() => setOpen(false)}
                      className="group flex items-baseline gap-5 sm:gap-8 py-5 sm:py-7"
                    >
                      <span
                        className={cn(
                          'mono-label shrink-0 w-6 transition-colors',
                          active && 'text-[#00D632]'
                        )}
                      >
                        {link.index}
                      </span>
                      <span
                        className={cn(
                          'text-3xl sm:text-5xl font-sans font-medium tracking-[-0.03em] leading-none transition-colors duration-150',
                          active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
                        )}
                      >
                        {link.label}
                      </span>
                      <ArrowRight className="ml-auto h-5 w-5 sm:h-6 sm:w-6 shrink-0 self-center text-muted-foreground/40 opacity-0 -translate-x-2 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        </nav>

        <div
          className={cn(
            'shrink-0 border-t border-border transition-opacity duration-500',
            open ? 'opacity-100' : 'opacity-0'
          )}
          style={{ transitionDelay: open ? '300ms' : '0ms' }}
        >
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <a
              href="mailto:hello@flowstate.homes"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              hello@flowstate.homes
            </a>
            <a
              href="#contact"
              onClick={() => setOpen(false)}
              className="inline-flex items-center justify-center gap-2 py-3 px-6 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150 self-start sm:self-auto"
            >
              <span>Submit a deal</span>
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </>
  )
}
