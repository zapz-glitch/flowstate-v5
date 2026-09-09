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
      let unavailable = 0
      let count = 0
      const image = async (photos?: string[]) => {
        const url = photos?.[0]
        if (!url || !/^\/user\/reports\/[a-zA-Z0-9_-]+\/assets\/[a-f0-9-]{36}$/.test(url)) return []
        if (++count > 20) { unavailable++; return [] }
        try {
          const response = await fetch(url, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) })
          if (!response.ok) throw new Error('Private image unavailable')
          const bytes = await response.blob()
          if (bytes.size > 5 * 1024 * 1024 || !['image/jpeg', 'image/png'].includes(bytes.type)) throw new Error('Image format unavailable for PDF')
          const encoded = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = reject
            reader.readAsDataURL(bytes)
          })
          return [encoded]
        } catch { unavailable++; return [] }
      }
      const subject = reportProps.subject ? { ...reportProps.subject, photos: await image(reportProps.subject.photos) } : undefined
      const items = []
      for (const comp of reportProps.comps?.items ?? []) items.push({ ...comp, photos: comp.isEnabled ? await image(comp.photos) : [] })
      const prepared = { ...reportProps, subject, comps: reportProps.comps ? { ...reportProps.comps, items } : undefined,
        riskFlags: [...(reportProps.riskFlags ?? []), ...(unavailable ? [`${unavailable} private report image(s) unavailable during PDF export`] : [])] }
      const blob = await pdf(<UnderwritingReportPDF {...prepared} />).toBlob()
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
      <span className="hidden sm:inline">{generating ? 'Generating...' : 'Download Report'}</span>
    </button>
  )
}
