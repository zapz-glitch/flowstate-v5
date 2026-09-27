'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { BarChart3, ExternalLink, Inbox } from 'lucide-react'
import {
  getActivityRows,
  getActivitySummary,
  getEngineMetrics,
  type ActivityRow,
  type EngineMetrics,
} from './actions'
import { getOfferQueue, type PipelineItem } from '../give-offer/actions'
import { jobIdForItem } from '../give-offer/queue'
import { cn } from '@/lib/utils'

const ROW_POLL_MS = 10_000
const METRICS_POLL_MS = 60_000

type WindowKey = 'today' | '24h' | '7d' | '30d'
const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
]

function sinceFor(w: WindowKey): string {
  const d = new Date()
  if (w === 'today') {
    d.setHours(0, 0, 0, 0)
  } else {
    d.setTime(d.getTime() - (w === '24h' ? 24 : w === '7d' ? 7 * 24 : 30 * 24) * 3600_000)
  }
  return d.toISOString()
}

interface Tile {
  key: string
  label: string
  /** Activity-event kinds counted + drilled for this tile */
  kinds: string[]
  /** Engine fallback metric when no activity rows exist yet */
  engine?: keyof EngineMetrics
}

const TILES: Tile[] = [
  { key: 'reachouts', label: 'Reach-outs', kinds: ['reachout', 'outbound_msg'], engine: 'newReachouts' },
  { key: 'responses', label: 'Responses', kinds: ['response', 'inbound_msg'], engine: 'responses' },
  { key: 'reactivated', label: 'Reactivated', kinds: ['reactivation'], engine: 'reactivations' },
  { key: 'underwrite', label: 'To underwriting', kinds: ['sent_to_underwriting'], engine: 'sentToUnderwriting' },
  { key: 'prepped', label: 'Offers prepped', kinds: ['offer_prepped'], engine: 'offersPrepped' },
  { key: 'sent', label: 'Offers sent', kinds: ['offer_sent'], engine: 'offersSent' },
  { key: 'hot', label: 'Hot leads', kinds: ['hot_lead'], engine: 'hotLeads' },
  { key: 'evalfailed', label: 'Evals failed', kinds: ['eval_failed'], engine: 'evalsFailed' },
  { key: 'contract', label: 'Under contract', kinds: ['under_contract'] },
  { key: 'assigned', label: 'Assigned', kinds: ['assigned'] },
]

const KIND_LABELS: Record<string, string> = {
  reachout: 'Reach-out',
  outbound_msg: 'Outbound SMS',
  inbound_msg: 'Inbound SMS',
  response: 'Response',
  reactivation: 'Reactivation',
  stage_move: 'Stage move',
  contacting: 'Contacting',
  sent_to_underwriting: 'To underwriting',
  offer_prepped: 'Offer prepped',
  offer_sent: 'Offer sent',
  terms_prep: 'Terms prep',
  under_contract: 'Under contract',
  assigned: 'Assigned',
  closed: 'Closed',
  offer_declined: 'Offer declined',
  no_motivation: 'No motivation',
  no_margin: 'No margin',
  offer_held: 'Offer held',
  offer_followup: 'Offer follow-up',
  delivery_check: 'Delivery check',
  eval_completed: 'Eval completed',
  eval_failed: 'Eval failed',
  owner_relay_question: 'Owner relay Q',
  owner_relay_answer: 'Owner relay A',
  no_margin_followup: 'No-margin follow-up',
  no_motivation_followup: 'No-motivation follow-up',
  intake_sent: 'Intake sent',
  hot_lead: 'Hot lead',
  opt_out: 'Opt out',
  human_attention: 'Human attention',
  convo: 'Conversation',
}

function kindLabel(k: string): string {
  return KIND_LABELS[k] ?? k.replace(/_/g, ' ')
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function fmtDay(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function AnalyticsPage() {
  const [win, setWin] = useState<WindowKey>('today')
  const [metrics, setMetrics] = useState<EngineMetrics | null>(null)
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const [queue, setQueue] = useState<PipelineItem[]>([])
  const [selected, setSelected] = useState<Tile | null>(null)
  const [rows, setRows] = useState<ActivityRow[] | null>(null)
  const [rowsLoading, setRowsLoading] = useState(false)
  const selectedRef = useRef<Tile | null>(null)
  selectedRef.current = selected

  const since = useMemo(() => sinceFor(win), [win])

  // Engine funnel metrics — authoritative headline counts (60s).
  useEffect(() => {
    let cancelled = false
    const load = () =>
      getEngineMetrics(since).then((r) => {
        if (!cancelled && r.ok) setMetrics(r.metrics)
      })
    load()
    const t = setInterval(load, METRICS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [since])

  // Our activity store — tile counts + drill-down rows (10s).
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const s = await getActivitySummary(since)
      if (cancelled || !s.ok) return
      setCounts(s.counts)
      const sel = selectedRef.current
      const r = await getActivityRows(sel ? sel.kinds : [], since)
      if (!cancelled && r.ok) setRows(r.rows)
    }
    load()
    const t = setInterval(load, ROW_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [since])

  // Queue items — map leadId → give-offer jobId for report links (60s).
  useEffect(() => {
    let cancelled = false
    const load = () =>
      getOfferQueue().then((q) => {
        if (!cancelled && q.ok) setQueue(q.items)
      })
    load()
    const t = setInterval(load, METRICS_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const jobByLead = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of queue) {
      const j = jobIdForItem(i)
      if (i.leadId && j) m.set(i.leadId, j)
    }
    return m
  }, [queue])

  const hasActivity = useMemo(() => !!counts && Object.values(counts).some((n) => n > 0), [counts])

  const tileCount = useCallback(
    (t: Tile): number | null => {
      if (hasActivity && counts) {
        return t.kinds.reduce((sum, k) => sum + (counts[k] ?? 0), 0)
      }
      const v = t.engine != null ? metrics?.[t.engine] : null
      return typeof v === 'number' ? v : null
    },
    [counts, hasActivity, metrics],
  )

  const convRate = useMemo(() => {
    if (hasActivity && counts) {
      const sent = (counts['reachout'] ?? 0) + (counts['outbound_msg'] ?? 0)
      const got = (counts['response'] ?? 0) + (counts['inbound_msg'] ?? 0)
      return sent > 0 ? Math.round((got / sent) * 100) : null
    }
    return metrics?.responseRatePct ?? null
  }, [counts, hasActivity, metrics])

  const select = (t: Tile) => {
    const next = selected?.key === t.key ? null : t
    setSelected(next)
    setRowsLoading(true)
    getActivityRows(next ? next.kinds : [], since).then((r) => {
      if (r.ok) setRows(r.rows)
      setRowsLoading(false)
    })
  }

  return (
    <div className="playground-bg -m-4 sm:-m-6 lg:-m-8 min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden">
      {/* Header band — same geometry + card chrome as Property Search */}
      <div className="px-4 sm:px-6 lg:px-4 pt-3 pb-1 lg:pt-4 lg:pb-0 lg:h-20 lg:flex lg:items-center lg:border-b lg:border-border space-y-3 flex-shrink-0">
        <div className="w-full border border-border/60 overflow-hidden bg-background shadow-sm corner-accents corner-accents-bottom">
          <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
            <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <BarChart3 className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-body-sm text-foreground-secondary">Analytics</div>
              <div className="text-xs text-foreground-tertiary">
                Conversation-intelligence funnel
                {metrics ? ` · ${metrics.queueDepth} in queue` : ''}
                {metrics?.avgPrepMinutes != null ? ` · avg prep ${Math.round(metrics.avgPrepMinutes)}m` : ''}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {WINDOWS.map((w) => (
                <button
                  key={w.key}
                  type="button"
                  onClick={() => setWin(w.key)}
                  className={cn(
                    'px-2.5 py-1 rounded text-[11px] font-medium transition-colors',
                    win === w.key
                      ? 'bg-primary/15 text-primary'
                      : 'text-foreground-tertiary hover:text-foreground-secondary hover:bg-secondary/60',
                  )}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 sm:px-6 pt-3 pb-4 space-y-3">
          {/* Metric tiles — click to drill into event rows */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {TILES.map((t) => {
              const n = tileCount(t)
              const active = selected?.key === t.key
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => select(t)}
                  className={cn(
                    'border border-border/60 bg-background shadow-sm px-3 py-2.5 text-left transition-colors corner-accents',
                    active ? 'border-primary/60 bg-primary/5' : 'hover:border-border hover:bg-secondary/40',
                  )}
                >
                  <div className="text-[9px] uppercase tracking-wider text-foreground-tertiary">{t.label}</div>
                  <div className="text-lg font-bold tabular-nums mt-0.5">{n ?? '—'}</div>
                </button>
              )
            })}
            {/* Conv. rate — derived, not clickable */}
            <div className="border border-border/60 bg-background shadow-sm px-3 py-2.5 corner-accents">
              <div className="text-[9px] uppercase tracking-wider text-foreground-tertiary">Conv. rate</div>
              <div className="text-lg font-bold tabular-nums mt-0.5">{convRate == null ? '—' : `${convRate}%`}</div>
            </div>
          </div>

          {/* Drill-down — recent activity or the selected tile's rows */}
          <div className="border border-border/60 bg-background shadow-sm">
            <div className="px-4 py-2.5 border-b border-border/50 flex items-center justify-between">
              <div className="text-xs font-medium text-foreground-secondary">
                {selected ? `${selected.label} — event detail` : 'Recent activity'}
              </div>
              <div className="text-[10px] text-foreground-tertiary">
                {WINDOWS.find((w) => w.key === win)?.label}
                {rows ? ` · ${rows.length} event${rows.length === 1 ? '' : 's'}` : ''}
              </div>
            </div>
            <div className="divide-y divide-border/50">
              {rowsLoading ? (
                <div className="px-4 py-8 text-center text-xs text-foreground-tertiary">Loading…</div>
              ) : rows && rows.length === 0 ? (
                <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
                  <Inbox className="w-4 h-4 text-foreground-tertiary" />
                  <div className="text-xs text-foreground-tertiary">
                    {hasActivity || counts
                      ? `No ${selected ? selected.label.toLowerCase() : ''} events in this window yet.`
                      : 'No activity ingested yet — the engine starts pushing once the ingest endpoint is wired.'}
                  </div>
                </div>
              ) : rows ? (
                rows.map((r) => {
                  const jobId = r.leadId ? jobByLead.get(r.leadId) : undefined
                  const meta = (() => {
                    try {
                      return r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null
                    } catch {
                      return null
                    }
                  })()
                  const stage = typeof meta?.stage === 'string' ? meta.stage : null
                  return (
                    <div key={r.id} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <div className="w-20 flex-shrink-0 text-foreground-tertiary tabular-nums">
                        <div>{fmtTime(r.ts)}</div>
                        <div className="text-[9px]">{fmtDay(r.ts)}</div>
                      </div>
                      <span className="px-1.5 py-0.5 rounded bg-secondary/60 text-foreground-secondary text-[10px] flex-shrink-0">
                        {kindLabel(r.kind)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-foreground-primary">
                          {r.propertyAddress ?? r.value ?? '—'}
                        </div>
                        {stage && <div className="text-[10px] text-foreground-tertiary">→ {stage}</div>}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {jobId && (
                          <Link
                            href={`/dashboard/give-offer/${jobId}`}
                            className="text-[10px] text-primary hover:underline"
                          >
                            Offer
                          </Link>
                        )}
                        {r.leadId && (
                          <a
                            href={`https://app.close.com/lead/${r.leadId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="flex items-center gap-1 text-[10px] text-primary hover:underline"
                          >
                            Close
                            <ExternalLink size={10} />
                          </a>
                        )}
                      </div>
                    </div>
                  )
                })
              ) : (
                <div className="px-4 py-8 text-center text-xs text-foreground-tertiary">Loading…</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
