'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileSignature, CircleSlash, Check, X, Timer, RefreshCw, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getOfferQueue, getPipelineMetrics, type PipelineItem, type PipelineMetrics } from './actions'
import { dispatchOfferPrep, declineOffer } from '../analyze/actions'

const POLL_MS = 4000

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ${seconds % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Live seconds elapsed since an ISO timestamp — re-renders every second. */
function useElapsed(sinceIso: string | null): number {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!sinceIso) return
    const start = Date.parse(sinceIso)
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [sinceIso])
  return elapsed
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-3 py-2">
      <div className="text-[9px] uppercase tracking-wider text-foreground-tertiary">{label}</div>
      <div className="text-sm font-bold tabular-nums mt-0.5">{value}</div>
    </div>
  )
}

export default function GiveOfferPage() {
  const [items, setItems] = useState<PipelineItem[]>([])
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<{ ok: boolean; label: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const decidedIds = useRef(new Set<string>())

  const refresh = useCallback(async () => {
    const [q, m] = await Promise.all([getOfferQueue(), getPipelineMetrics()])
    if (q.ok) {
      const visible = q.items.filter((i) => !decidedIds.current.has(i.id))
      setItems(visible)
      setCurrentId((prev) => (prev && visible.some((i) => i.id === prev) ? prev : visible[0]?.id ?? null))
    }
    if (m.ok) setMetrics(m.metrics)
  }, [])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, POLL_MS)
    return () => clearInterval(t)
  }, [refresh])

  const current = items.find((i) => i.id === currentId) ?? items[0] ?? null
  const elapsed = useElapsed(current?.stageEnteredAt ?? null)

  const decide = useCallback(
    async (workflow: 'prep_offer' | 'no_margin') => {
      if (!current || busy) return
      setBusy(true)
      setOutcome(null)
      try {
        const res =
          workflow === 'prep_offer'
            ? await dispatchOfferPrep({
                leadId: current.leadId ?? undefined,
                propertyAddress: current.address,
                purchasePrice: current.wholesalePrice ?? 0,
                opportunityId: current.opportunityId ?? undefined,
              })
            : await declineOffer({ leadId: current.leadId ?? undefined, propertyAddress: current.address })
        if (!res.ok) {
          setOutcome({ ok: false, label: res.error ?? 'Dispatch failed' })
          return
        }
        setOutcome({
          ok: true,
          label:
            workflow === 'prep_offer'
              ? res.idempotent
                ? 'Already dispatched'
                : 'Offer prep dispatched'
              : 'Decline recorded',
        })
        // Remove from local queue immediately; the API already advanced it.
        decidedIds.current.add(current.id)
        setTimeout(() => {
          setItems((prev) => {
            const next = prev.filter((i) => i.id !== current.id)
            setCurrentId(next[0]?.id ?? null)
            return next
          })
          setOutcome(null)
        }, 1200)
      } catch {
        setOutcome({ ok: false, label: 'Dispatch failed' })
      } finally {
        setBusy(false)
      }
    },
    [current, busy],
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header + metrics */}
      <div className="shrink-0 border-b border-border px-4 sm:px-6 py-3">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-sm font-semibold">Give Offer</h1>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-foreground-secondary tabular-nums">
            {items.length} in queue
          </span>
          <button
            type="button"
            onClick={refresh}
            className="ml-auto flex items-center gap-1 text-[10px] text-foreground-tertiary hover:text-foreground"
          >
            <RefreshCw size={11} /> Refresh
          </button>
        </div>
        {metrics && (
          <div className="grid grid-cols-4 sm:grid-cols-8 divide-x divide-border border border-border rounded-sm bg-background/60">
            <MetricCell label="Reach-outs" value={String(metrics.reachOuts)} />
            <MetricCell label="Responses" value={String(metrics.responses)} />
            <MetricCell
              label="Conv."
              value={metrics.reachToResponseRate == null ? '—' : `${Math.round(metrics.reachToResponseRate * 100)}%`}
            />
            <MetricCell label="Reactivated" value={String(metrics.reactivations)} />
            <MetricCell label="To underwrite" value={String(metrics.sentToUnderwriting)} />
            <MetricCell label="Offers prepped" value={String(metrics.offersPrepared)} />
            <MetricCell label="Sent" value={String(metrics.offersSent)} />
            <MetricCell
              label="Avg decision"
              value={metrics.avgDecisionSeconds == null ? '—' : formatElapsed(Math.round(metrics.avgDecisionSeconds))}
            />
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* Queue list */}
        <div className="w-56 shrink-0 border-r border-border overflow-y-auto">
          {items.length === 0 && (
            <div className="p-4 text-xs text-foreground-tertiary">Queue is empty — properties land here when underwriting completes.</div>
          )}
          {items.map((item, i) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setCurrentId(item.id)}
              className={cn(
                'w-full text-left px-3 py-2.5 border-b border-border/50 text-xs transition-colors',
                item.id === current?.id ? 'bg-secondary/60' : 'hover:bg-secondary/30',
              )}
            >
              <div className="font-medium truncate">{item.address}</div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-[10px] text-foreground-tertiary tabular-nums">
                  #{i + 1} · waiting {formatElapsed(Math.floor((Date.now() - Date.parse(item.stageEnteredAt)) / 1000))}
                </span>
                {item.wholesalePrice != null && (
                  <span className="text-[10px] text-foreground-secondary tabular-nums">
                    ${Math.round(item.wholesalePrice / 1000)}K
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>

        {/* Current item */}
        <div className="flex-1 flex items-center justify-center p-6">
          {!current ? (
            <div className="text-center text-sm text-foreground-tertiary">
              {items.length === 0 ? 'Nothing waiting on an offer.' : 'Select a property'}
            </div>
          ) : (
            <div className="w-full max-w-md border border-border rounded-sm bg-background/95 backdrop-blur-sm">
              <div className="px-4 pt-4 pb-3 border-b border-border">
                <div className="text-[9px] uppercase tracking-wider text-foreground-tertiary mb-1">Ready for offer</div>
                <div className="text-base font-semibold">{current.address}</div>
                <div className="flex items-center gap-3 mt-2 text-xs text-foreground-secondary">
                  <span className="flex items-center gap-1 tabular-nums">
                    <Timer size={12} className="text-foreground-tertiary" />
                    {formatElapsed(elapsed)} in queue
                  </span>
                  {current.wholesalePrice != null && (
                    <span className="tabular-nums">
                      Wholesale <b className="text-foreground">${current.wholesalePrice.toLocaleString('en-US')}</b>
                    </span>
                  )}
                  {current.leadId && <span className="text-[10px] text-foreground-tertiary truncate">{current.leadId}</span>}
                </div>
              </div>
              <div className="px-4 py-3">
                <div className="text-xs text-foreground-secondary mb-3">Dispatch the offer workflow or mark this property no-margin.</div>
                <div className="relative min-h-[34px]">
                  {outcome ? (
                    <div
                      key="outcome"
                      className={cn(
                        'flex items-center gap-1.5 text-xs font-medium animate-in fade-in duration-300',
                        outcome.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500',
                      )}
                    >
                      {outcome.ok ? <Check size={14} /> : <X size={14} />}
                      {outcome.label}
                    </div>
                  ) : (
                    <div key="buttons" className="flex items-center gap-2 animate-in fade-in duration-300">
                      <button
                        type="button"
                        onClick={() => decide('prep_offer')}
                        disabled={busy || !current.wholesalePrice}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-emerald-600/40 text-xs font-medium text-emerald-600 hover:bg-emerald-500/10 transition-colors disabled:opacity-50 dark:text-emerald-400"
                        title={current.wholesalePrice ? 'Prep offer — dispatch to the Devin listener + engine' : 'No wholesale price on record'}
                      >
                        {busy ? <RefreshCw size={13} className="animate-spin" /> : <FileSignature size={13} />}
                        Prep offer
                      </button>
                      <button
                        type="button"
                        onClick={() => decide('no_margin')}
                        disabled={busy}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border border-border text-xs text-foreground-secondary hover:bg-secondary transition-colors disabled:opacity-50"
                      >
                        <CircleSlash size={13} />
                        No margin
                      </button>
                    </div>
                  )}
                </div>
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      const idx = items.findIndex((i) => i.id === current.id)
                      setCurrentId(items[(idx + 1) % items.length].id)
                      setOutcome(null)
                    }}
                    className="mt-3 flex items-center gap-1 text-[10px] text-foreground-tertiary hover:text-foreground"
                  >
                    Next property <ArrowRight size={11} />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
