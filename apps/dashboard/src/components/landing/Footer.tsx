'use client'

export function Footer() {
  return (
    <footer className="relative py-10 overflow-hidden border-t border-border">
      <div className="max-w-6xl mx-auto px-6 flex items-center justify-between">
        <p className="mono-label">
          &copy; {new Date().getFullYear()} Flowstate
        </p>
        <p className="mono-label">All rights reserved</p>
      </div>
    </footer>
  )
}
