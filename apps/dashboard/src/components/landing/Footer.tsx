'use client'

export function Footer() {
  return (
    <footer className="relative py-8 overflow-hidden border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} Flowstate. All rights reserved.
        </p>
        <p className="text-sm text-muted-foreground/70">
          Built with love on Cloudflare Workers
        </p>
      </div>
    </footer>
  )
}
