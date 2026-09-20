'use client'

import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'

interface SiteFooterProps {
  onAdminClick: () => void
}

export function SiteFooter({ onAdminClick }: SiteFooterProps) {
  return (
    <footer className="border-t border-border bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <Link href="/" className="active:scale-[0.98] transition-transform duration-150">
            <Logo size="md" />
          </Link>
          <a
            href="mailto:hello@flowstate.homes"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            hello@flowstate.homes
          </a>
        </div>

        <div className="mt-10 pt-6 border-t border-border">
          <p className="text-xs text-muted-foreground/70 leading-relaxed max-w-2xl">
            Flowstate is a private real estate investment company. Flowstate is
            not a licensed real estate broker or agent and does not represent
            buyers or sellers in any transaction.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
            <p className="text-xs text-muted-foreground/50">
              &copy; {new Date().getFullYear()} Flowstate. All rights reserved.
            </p>
            <Link href="/privacy" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">
              Privacy Policy
            </Link>
            <Link href="/terms" className="text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors">
              Terms of Service
            </Link>
            <button
              onClick={onAdminClick}
              className="ml-auto text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              Admin
            </button>
          </div>
        </div>
      </div>
    </footer>
  )
}
