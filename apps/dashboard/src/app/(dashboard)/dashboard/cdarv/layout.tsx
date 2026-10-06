import Link from 'next/link'
import { PageHeader } from '@/components/ui/page-header'

const NAV = [
  { href: '/dashboard/cdarv', label: 'Review Queue' },
  { href: '/dashboard/cdarv/models', label: 'Training & Models' },
  { href: '/dashboard/cdarv/performance', label: 'Performance' },
]

export default function CdarvLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      {/* CDARV is a shadow tool: the page says so, and that production is untouched */}
      <div>
        <PageHeader
          title="CDARV"
          actions={<span className="text-body-sm text-foreground-tertiary">Experimental / Shadow</span>}
        />
        <p className="mt-1 text-body-sm text-foreground-tertiary">Production underwriting is unaffected.</p>
      </div>
      <nav className="flex gap-1 border-b border-border">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="px-3 py-2 text-body-sm text-foreground-secondary hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 rounded-t-md transition-colors"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}
