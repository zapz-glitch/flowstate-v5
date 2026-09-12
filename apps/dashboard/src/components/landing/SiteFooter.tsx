import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'

export function SiteFooter() {
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
          <p className="text-xs text-muted-foreground/50 mt-3">
            &copy; {new Date().getFullYear()} Flowstate. All rights reserved.
          </p>
        </div>
      </div>
    </footer>
  )
}
