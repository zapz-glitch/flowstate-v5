'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { prefetchReport } from '../give-offer/queue'

/**
 * Report links warm the report fetch on hover/focus/touch so the detail
 * page mounts onto data instead of a skeleton. Shares the give-offer
 * queue's prefetch map — report-page-view consumes it via
 * takeReportPrefetch, and the 30s GET cache covers revisits.
 */
export function ReportLink({ jobId, href, className, title, children }: {
  jobId: string
  href: string
  className?: string
  title?: string
  children: ReactNode
}) {
  const warm = () => prefetchReport(jobId)
  return (
    <Link
      href={href}
      className={className}
      title={title}
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
    >
      {children}
    </Link>
  )
}
