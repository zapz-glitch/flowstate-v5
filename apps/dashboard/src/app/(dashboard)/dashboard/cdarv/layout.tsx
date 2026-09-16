import Link from 'next/link'

const NAV = [
  { href: '/dashboard/cdarv', label: 'Review Queue' },
  { href: '/dashboard/cdarv/models', label: 'Training & Models' },
  { href: '/dashboard/cdarv/performance', label: 'Performance' },
]

export default function CdarvLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="space-y-1">
        <h1 className="text-heading-lg text-foreground tracking-tight">
          CDARV <span className="text-body-sm text-foreground-tertiary font-normal">— Experimental / Shadow</span>
        </h1>
        <p className="text-body text-foreground-tertiary">
          Comp-Derived After Repair Value. Learning loop for comp selection — production underwriting is unaffected.
        </p>
      </div>
      <nav className="flex gap-1 border-b border-border">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="px-3 py-2 text-body-sm text-foreground-secondary hover:text-foreground hover:bg-secondary/50 rounded-t-md transition-colors"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}
