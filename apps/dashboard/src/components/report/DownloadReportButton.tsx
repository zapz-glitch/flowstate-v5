'use client'

import dynamic from 'next/dynamic'
import type { UnderwritingReportProps } from './UnderwritingReportPDF'

const DownloadReportButtonInner = dynamic(
  () => import('./DownloadReportButtonInner'),
  {
    ssr: false,
    loading: () => (
      <button
        type="button"
        disabled
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-body-sm text-foreground-tertiary border border-border opacity-50 cursor-not-allowed no-print"
      >
        <span className="w-3.5 h-3.5 border-2 border-foreground-tertiary/30 border-t-foreground-tertiary rounded-full animate-spin" />
        <span className="hidden sm:inline">PDF</span>
      </button>
    ),
  }
)

interface DownloadReportButtonProps {
  reportProps: UnderwritingReportProps
  filename?: string
}

export function DownloadReportButton({ reportProps, filename }: DownloadReportButtonProps) {
  return <DownloadReportButtonInner reportProps={reportProps} filename={filename} />
}
