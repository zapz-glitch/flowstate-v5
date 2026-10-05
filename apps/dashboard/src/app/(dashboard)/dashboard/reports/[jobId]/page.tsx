// Route entry — Next.js pages only accept params/searchParams; the queue
// prop variant lives on ReportPageView for the Give Offer wrapper.
'use client'

import { ReportPageView } from './report-page-view'

export default function DashboardReportPage({ params }: { params: Promise<{ jobId: string }> }) {
  return <ReportPageView params={params} />
}
