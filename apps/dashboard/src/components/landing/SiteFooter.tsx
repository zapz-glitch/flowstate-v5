import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-3">
          <div>
            <Logo size="md" />
            <p className="mt-4 text-sm text-muted-foreground leading-relaxed max-w-xs">
              Private real estate investment company. We buy houses as-is,
              for cash, and close in 21 days or less.
            </p>
          </div>

          <div>
            <p className="mono-label !text-[10px] mb-4">Site</p>
            <ul className="space-y-2.5 text-sm">
              <li><Link href="#what-we-buy" className="text-muted-foreground hover:text-foreground transition-colors">What we buy</Link></li>
              <li><Link href="#process" className="text-muted-foreground hover:text-foreground transition-colors">Process</Link></li>
              <li><Link href="#network" className="text-muted-foreground hover:text-foreground transition-colors">Who we work with</Link></li>
              <li><Link href="#contact" className="text-muted-foreground hover:text-foreground transition-colors">Contact</Link></li>
            </ul>
          </div>

          <div>
            <p className="mono-label !text-[10px] mb-4">Contact</p>
            <ul className="space-y-2.5 text-sm">
              <li>
                <a href="mailto:hello@flowstate.homes" className="text-muted-foreground hover:text-foreground transition-colors">
                  hello@flowstate.homes
                </a>
              </li>
              <li>
                <Link href="/docs" className="text-muted-foreground hover:text-foreground transition-colors">
                  API documentation
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-12 pt-6 border-t border-border">
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
