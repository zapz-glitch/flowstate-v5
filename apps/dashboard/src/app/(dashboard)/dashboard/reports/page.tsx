import Link from 'next/link'
import { Suspense } from 'react'
import { getSavedReports } from '@/lib/api'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { ReportSearchInput } from './search-input'
import { DeleteReportButton } from './delete-report-button'
import { formatAddressCasing, formatCityState } from '@/components/analysis/format-helpers'

const REPORTS_PER_PAGE = 20

interface SearchParams {
  page?: string
  search?: string
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
    const search = searchParams.search || ''
    const response = await getSavedReports(page, REPORTS_PER_PAGE, search)
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
    // A failed fetch is an error, not a loading state: say so, and offer a retry on the same page
    const retry = new URLSearchParams()
    if (params.search) retry.set('search', params.search)
    if (params.page) retry.set('page', params.page)
    const query = retry.toString()
    return (
      <div className="space-y-6">
        <PageHeader title="Property Reports" />
        <ErrorState
          title="Couldn't load your reports"
          detail="Your saved reports didn't come back. Try again. If it keeps failing, check your connection or sign in again."
          action={{ label: 'Try again', href: `/dashboard/reports${query ? `?${query}` : ''}` }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      <div className="space-y-4">
        <PageHeader title="Property Reports" />
        <div className="flex items-center gap-3">
          <div className="max-w-sm flex-1">
            <Suspense>
              <ReportSearchInput />
            </Suspense>
          </div>
          <p className="text-body-sm text-foreground-tertiary flex-shrink-0">
            {data.pagination.total.toLocaleString()}{params.search ? ' matching' : ' total'}
          </p>
        </div>
      </div>

      {/* Empty state */}
      {data.reports.length === 0 ? (
        <Card className="overflow-hidden">
          <EmptyState
            title={params.search ? 'No matching reports' : 'No reports yet'}
            description={params.search ? `No reports found for "${params.search}".` : 'Run an analysis to create your first report.'}
            action={params.search ? { label: 'Clear search', href: '/dashboard/reports' } : { label: 'Run an analysis', href: '/dashboard/analyze' }}
          />
        </Card>
      ) : (
        <>
          {/* Mobile card layout */}
          <div className="space-y-3 md:hidden">
            {data.reports.map((report) => (
              <Link
                key={report.id}
                href={`/dashboard/reports/${report.jobId}`}
                className="block"
              >
                <Card className="px-4 py-3 hover:bg-secondary/30 transition-colors">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-body-sm font-medium text-foreground truncate">
                        {formatAddressCasing(report.propertyAddress)}
                      </p>
                      <p className="text-caption text-foreground-tertiary">
                        {formatCityState(report.propertyCity, report.propertyState) || '-'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <DeleteReportButton jobId={report.jobId} address={report.propertyAddress} />
                      <ChevronRight className="w-4 h-4 text-foreground-tertiary" />
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-caption">
                    {report.arv != null && (
                      <span className="text-foreground-secondary">
                        <span className="text-foreground-tertiary">ARV</span> {formatCurrency(report.arv)}
                      </span>
                    )}
                    {report.maxAllowableOffer != null && (
                      <span className="text-foreground-secondary">
                        <span className="text-foreground-tertiary">Buy</span> {formatCurrency(report.maxAllowableOffer)}
                      </span>
                    )}
                    {report.estimatedRepairs != null && (
                      <span className="text-foreground-secondary">
                        <span className="text-foreground-tertiary">Rehab</span> {formatCurrency(report.estimatedRepairs)}
                      </span>
                    )}
                  </div>
                  <p className="text-caption text-foreground-tertiary mt-1.5">
                    {new Date(report.createdAt).toLocaleDateString()}
                  </p>
                </Card>
              </Link>
            ))}
          </div>

          {/* Desktop table layout */}
          <Card className="hidden md:block">
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
                    <th className="text-center px-4 py-3 text-caption font-medium text-foreground-tertiary">
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {data.reports.map((report) => (
                    <tr
                      key={report.id}
                      className="hover:bg-secondary/30 transition-colors"
                    >
                      <td className="px-6 py-4 text-body-sm text-foreground max-w-[250px] truncate" title={report.propertyAddress}>
                        {formatAddressCasing(report.propertyAddress)}
                      </td>
                      <td className="px-6 py-4 text-body-sm text-foreground-secondary whitespace-nowrap">
                        {formatCityState(report.propertyCity, report.propertyState) || '-'}
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
                          href={`/dashboard/reports/${report.jobId}`}
                          className="text-body-sm text-primary hover:text-primary/80 transition-colors"
                        >
                          View
                        </Link>
                      </td>
                      <td className="px-4 py-4 text-center">
                        <DeleteReportButton jobId={report.jobId} address={report.propertyAddress} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Pagination */}
          {data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-body-sm text-foreground-tertiary">
                Page {data.pagination.page} of {data.pagination.totalPages}
              </p>
              <div className="flex items-center gap-2">
                {data.pagination.hasPrev ? (
                  <Link
                    href={`/dashboard/reports?page=${data.pagination.page - 1}${params.search ? `&search=${encodeURIComponent(params.search)}` : ''}`}
                    className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-secondary hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span className="hidden sm:inline">Previous</span>
                  </Link>
                ) : (
                  <span className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-tertiary/50 cursor-not-allowed">
                    <ChevronLeft className="w-4 h-4" />
                    <span className="hidden sm:inline">Previous</span>
                  </span>
                )}
                {data.pagination.hasNext ? (
                  <Link
                    href={`/dashboard/reports?page=${data.pagination.page + 1}${params.search ? `&search=${encodeURIComponent(params.search)}` : ''}`}
                    className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-secondary hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                  >
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight className="w-4 h-4" />
                  </Link>
                ) : (
                  <span className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-tertiary/50 cursor-not-allowed">
                    <span className="hidden sm:inline">Next</span>
                    <ChevronRight className="w-4 h-4" />
                  </span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
