'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Menu, ArrowUpRight } from 'lucide-react'
import { Logo } from '@/components/ui/Logo'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
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
          <Link
            href="/"
            className="flex items-center active:scale-[0.98] transition-transform duration-150"
            onClick={() => setOpen(false)}
          >
            <Logo size="md" />
          </Link>

          <button
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="p-2 -mr-2 text-muted-foreground hover:text-foreground active:scale-90 transition-all duration-150"
          >
            <Menu className="h-5 w-5" />
          </button>
        </div>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-sm bg-background border-l border-border p-0 flex flex-col">
          <SheetHeader className="px-6 pt-6 pb-4">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <SheetDescription className="sr-only">Site menu</SheetDescription>
          </SheetHeader>

          <nav className="px-6 pt-4 flex-1">
            <ul className="space-y-1">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    onClick={() => setOpen(false)}
                    className="block py-2 font-serif italic text-2xl text-foreground transition-all duration-150 hover:translate-x-1 hover:text-foreground-secondary active:scale-[0.98]"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="px-6 pb-8 mt-auto">
            <button
              onClick={() => { setOpen(false); onPortalClick() }}
              className="w-full flex items-center justify-between py-3 px-5 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 active:scale-[0.98] transition-all duration-150"
            >
              <span>{isSignedIn ? 'Dashboard' : 'Login'}</span>
              <ArrowUpRight className="h-4 w-4" />
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </header>
  )
}
