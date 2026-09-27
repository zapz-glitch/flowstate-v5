'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileSignature, CircleSlash, Check, X, RefreshCw, ExternalLink } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { getOfferQueue, getPipelineMetrics, type PipelineItem, type PipelineMetrics } from './actions'
import { dispatchOfferPrep, declineOffer } from '../analyze/actions'

const POLL_MS = 5000

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Engine timestamps arrive as "YYYY-MM-DD HH:MM:SS" UTC. */
function parseQueuedAt(s: string): number {
  return Date.parse(s.includes('T') ? s : s.replace(' ', 'T') + 'Z')
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-foreground-tertiary">{label}</div>
      <div className="text-sm font-bold tabular-nums mt-0.5">{value}</div>
    </div>
  )
}

const itemKey = (i: PipelineItem) => i.leadId
const itemName = (i: PipelineItem) => i.address ?? i.displayName ?? i.leadId

export default function GiveOfferPage() {
  const [items, setItems] = useState<PipelineItem[]>([])
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; label: string }>>({})
  const decidedIds = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    const [q, m] = await Promise.all([getOfferQueue(), getPipelineMetrics()])
    if (q.ok) {
      setItems(q.items.filter((i) => !decidedIds.current.has(itemKey(i))))
    }
    if (m.ok) setMetrics(m.metrics)
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  const decide = useCallback(
    async (item: PipelineItem, workflow: 'prep_offer' | 'no_margin') => {
      const id = itemKey(item)
      if (busyId) return
      setBusyId(id)
      try {
        const res =
          workflow === 'prep_offer'
            ? await dispatchOfferPrep({
                leadId: item.leadId ?? undefined,
                propertyAddress: itemName(item),
                purchasePrice: item.wholesalePrice ?? 0,
                opportunityId: item.opportunityId ?? undefined,
              })
            : await declineOffer({ leadId: item.leadId ?? undefined, propertyAddress: itemName(item) })
        setResults((prev) => ({
          ...prev,
          [id]: res.ok
            ? {
                ok: true,
                label: workflow === 'prep_offer' ? (res.idempotent ? 'Already dispatched' : 'Offer prep dispatched') : 'Decline recorded',
              }
            : { ok: false, label: res.error ?? 'Dispatch failed' },
        }))
        if (res.ok) {
          decidedIds.current.add(id)
          // Fade the outcome briefly, then the row clears and the queue rolls up.
          setTimeout(() => {
            setItems((prev) => prev.filter((i) => itemKey(i) !== id))
            setResults((prev) => {
              const next = { ...prev }
              delete next[id]
              return next
            })
          }, 1500)
        }
      } catch {
        setResults((prev) => ({ ...prev, [id]: { ok: false, label: 'Dispatch failed' } }))
      } finally {
        setBusyId(null)
      }
    },
    [busyId],
  )

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
          <div>
            <h1 className="text-title font-bold text-foreground tracking-tight">Give Offer</h1>
            <p className="text-body-sm text-foreground-secondary mt-1">
              Properties cleared for an offer — disposition each one and the queue rolls forward.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-caption text-foreground-secondary tabular-nums">
              {items.length} waiting
            </span>
            <button
              type="button"
              onClick={refresh}
              className="flex items-center gap-1 text-caption text-foreground-tertiary hover:text-foreground transition-colors"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        </div>
        {metrics && (
          <div className="grid grid-cols-4 sm:grid-cols-8 divide-x divide-border border border-border rounded-sm bg-background/60">
            <MetricCell label="Reach-outs" value={String(metrics.newReachouts)} />
            <MetricCell label="Responses" value={String(metrics.responses)} />
            <MetricCell
              label="Conv."
              value={metrics.responseRatePct == null ? '—' : `${Math.round(metrics.responseRatePct)}%`}
            />
            <MetricCell label="Reactivated" value={String(metrics.reactivations)} />
            <MetricCell label="To underwrite" value={String(metrics.sentToUnderwriting)} />
            <MetricCell label="Offers prepped" value={String(metrics.offersPrepped)} />
            <MetricCell label="Sent" value={String(metrics.offersSent)} />
            <MetricCell
              label="Avg prep"
              value={metrics.avgPrepMinutes == null ? '—' : `${Math.round(metrics.avgPrepMinutes)}m`}
            />
          </div>
        )}
      </div>

      {items.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <p className="text-body-sm text-foreground-secondary">Nothing waiting on an offer.</p>
          <p className="text-caption text-foreground-tertiary mt-1">
            Properties land here the moment underwriting completes.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((item, i) => {
            const id = itemKey(item)
            const waiting = Math.floor((Date.now() - parseQueuedAt(item.queuedAt)) / 1000)
            const result = results[id]
            const isBusy = busyId === id
            return (
              <Card key={id} className="px-4 py-3">
                <div className="flex items-center gap-4">
                  <span className="text-caption text-foreground-tertiary tabular-nums w-5 shrink-0">#{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-body-sm font-medium text-foreground truncate">{itemName(item)}</p>
                      {item.evalReportUrl && (
                        <a
                          href={item.evalReportUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-0.5 text-caption text-primary hover:underline shrink-0"
                        >
                          Report <ExternalLink size={11} />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-caption mt-0.5">
                      {item.wholesalePrice != null && (
                        <span className="text-foreground-secondary">
                          <span className="text-foreground-tertiary">Wholesale</span>{' '}
                          {formatCurrency(item.wholesalePrice)}
                        </span>
                      )}
                      <span className="text-foreground-tertiary tabular-nums">
                        waiting {formatElapsed(waiting)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {result ? (
                      <span
                        className={cn(
                          'flex items-center gap-1 text-caption font-medium animate-in fade-in duration-300',
                          result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500',
                        )}
                      >
                        {result.ok ? <Check size={13} /> : <X size={13} />}
                        {result.label}
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => decide(item, 'prep_offer')}
                          disabled={busyId != null || !item.wholesalePrice}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-emerald-600/40 text-caption font-medium text-emerald-600 hover:bg-emerald-500/10 transition-colors disabled:opacity-50 dark:text-emerald-400"
                          title={item.wholesalePrice ? 'Prep offer — dispatch to the listener + engine' : 'No wholesale price on record'}
                        >
                          {isBusy ? <RefreshCw size={12} className="animate-spin" /> : <FileSignature size={12} />}
                          Prep offer
                        </button>
                        <button
                          type="button"
                          onClick={() => decide(item, 'no_margin')}
                          disabled={busyId != null}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-caption text-foreground-secondary hover:bg-secondary transition-colors disabled:opacity-50"
                        >
                          {isBusy ? <RefreshCw size={12} className="animate-spin" /> : <CircleSlash size={12} />}
                          No margin
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
