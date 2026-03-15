'use client'

export function Footer() {
  return (
    <footer className="relative py-8 overflow-hidden border-t border-border">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">
          &copy; {new Date().getFullYear()} Flowstate. All rights reserved.
        </p>
      </div>
    </footer>
  )
}
