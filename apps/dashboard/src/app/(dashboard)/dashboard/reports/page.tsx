import Link from 'next/link'
import { getSavedReports } from '@/lib/api'
import { FileText, ChevronLeft, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/card'

const REPORTS_PER_PAGE = 20

interface SearchParams {
  page?: string
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

async function getReportsData(searchParams: SearchParams) {
  try {
    const page = parseInt(searchParams.page || '1', 10)
    const response = await getSavedReports(page, REPORTS_PER_PAGE)
    return {
      reports: response.reports,
      pagination: {
        page: response.pagination.page,
        totalPages: response.pagination.totalPages,
        total: response.pagination.total,
        hasNext: response.pagination.page < response.pagination.totalPages,
        hasPrev: response.pagination.page > 1,
      },
    }
  } catch {
    return null
  }
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const data = await getReportsData(params)

  if (!data) {
    return <div>Loading...</div>
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div className="space-y-1">
          <h1 className="text-heading-lg text-foreground tracking-tight">Reports</h1>
          <p className="text-body text-foreground-tertiary">
            View your saved property analysis reports
          </p>
        </div>
        <p className="text-body-sm text-foreground-tertiary">
          {data.pagination.total.toLocaleString()} total reports
        </p>
      </div>

      {/* Reports table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Address
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  City / State
                </th>
                <th className="text-right px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  ARV
                </th>
                <th className="text-right px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Buy Price
                </th>
                <th className="text-right px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Rehab
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Date
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.reports.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center">
                    <FileText className="w-12 h-12 mx-auto mb-3 text-foreground-tertiary opacity-50" />
                    <p className="text-body text-foreground-secondary">No reports yet</p>
                    <p className="text-body-sm text-foreground-tertiary mt-1">
                      Run an analysis to generate your first report
                    </p>
                  </td>
                </tr>
              ) : (
                data.reports.map((report) => (
                  <tr
                    key={report.id}
                    className="hover:bg-secondary/30 transition-colors"
                  >
                    <td className="px-6 py-4 text-body-sm text-foreground max-w-[250px] truncate">
                      {report.propertyAddress}
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary whitespace-nowrap">
                      {[report.propertyCity, report.propertyState]
                        .filter(Boolean)
                        .join(', ') || '-'}
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary text-right whitespace-nowrap">
                      {report.arv ? formatCurrency(report.arv) : '-'}
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary text-right whitespace-nowrap">
                      {report.maxAllowableOffer
                        ? formatCurrency(report.maxAllowableOffer)
                        : '-'}
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary text-right whitespace-nowrap">
                      {report.estimatedRepairs
                        ? formatCurrency(report.estimatedRepairs)
                        : '-'}
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary whitespace-nowrap">
                      {new Date(report.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/report/${report.jobId}`}
                        className="text-body-sm text-primary hover:text-primary/80 transition-colors"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data.pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-border">
            <p className="text-body-sm text-foreground-tertiary">
              Page {data.pagination.page} of {data.pagination.totalPages}
            </p>
            <div className="flex items-center gap-2">
              {data.pagination.hasPrev ? (
                <Link
                  href={`/dashboard/reports?page=${data.pagination.page - 1}`}
                  className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-secondary hover:bg-secondary rounded-lg transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </Link>
              ) : (
                <span className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-tertiary/50 cursor-not-allowed">
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </span>
              )}
              {data.pagination.hasNext ? (
                <Link
                  href={`/dashboard/reports?page=${data.pagination.page + 1}`}
                  className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-secondary hover:bg-secondary rounded-lg transition-colors"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Link>
              ) : (
                <span className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-tertiary/50 cursor-not-allowed">
                  Next
                  <ChevronRight className="w-4 h-4" />
                </span>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
