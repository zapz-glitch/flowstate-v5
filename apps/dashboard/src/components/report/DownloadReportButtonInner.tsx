'use client'

import { useState, useCallback } from 'react'
import { pdf } from '@react-pdf/renderer'
import { Download, Loader2 } from 'lucide-react'
import { UnderwritingReportPDF, type UnderwritingReportProps } from './UnderwritingReportPDF'

interface DownloadReportButtonInnerProps {
  reportProps: UnderwritingReportProps
  filename?: string
}

export default function DownloadReportButtonInner({
  reportProps,
  filename,
}: DownloadReportButtonInnerProps) {
  const [generating, setGenerating] = useState(false)

  const handleDownload = useCallback(async () => {
    setGenerating(true)
    try {
      const blob = await pdf(<UnderwritingReportPDF {...reportProps} />).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename || `underwriting-report-${reportProps.address.replace(/[^a-zA-Z0-9]/g, '-')}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('PDF generation failed:', err)
    } finally {
      setGenerating(false)
    }
  }, [reportProps, filename])

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={generating}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-body-sm text-foreground-secondary hover:text-foreground hover:bg-secondary transition-colors border border-border disabled:opacity-50 disabled:cursor-not-allowed no-print"
    >
      {generating ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : (
        <Download className="w-3.5 h-3.5" />
      )}
      <span className="hidden sm:inline">{generating ? 'Generating...' : 'Download PDF'}</span>
    </button>
  )
}
