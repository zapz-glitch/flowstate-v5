'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { BarChart3, Inbox } from 'lucide-react'
import { FlowGlyph } from '@/components/ui/Logo'
import {
  getAnalyticsView,
  type ActivityRow,
  type EngineMetrics,
} from './actions'
import type { PipelineItem } from '../give-offer/actions'
import { jobIdForItem } from '../give-offer/queue'
import { cn } from '@/lib/utils'

const ROW_POLL_MS = 10_000

// Share one in-flight view request across mounts/StrictMode remounts —
// the action itself runs once per POST otherwise.
let viewInflight: ReturnType<typeof getAnalyticsView> | null = null
function analyticsView(since: string | undefined): ReturnType<typeof getAnalyticsView> {
  if (viewInflight) return viewInflight
  const p = getAnalyticsView(since).finally(() => { if (viewInflight === p) viewInflight = null })
  viewInflight = p
  return p
}

type WindowKey = 'today' | '24h' | '7d' | '30d' | 'all'
const WINDOWS: { key: WindowKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: 'all', label: 'All' },
]

function sinceFor(w: WindowKey): string | undefined {
  if (w === 'all') return undefined
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
  /** Historical events arrive as stage_move rows — value "From->To";
   *  this matches rows whose target stage is this label */
  stageTarget?: string
}

const TILES: Tile[] = [
  { key: 'reachouts', label: 'Reach-outs', kinds: ['reachout', 'outbound_msg'], engine: 'newReachouts' },
  { key: 'responses', label: 'Responses', kinds: ['response', 'inbound_msg'], engine: 'responses' },
  { key: 'reactivated', label: 'Reactivated', kinds: ['reactivation'], engine: 'reactivations' },
  { key: 'underwrite', label: 'To underwriting', kinds: ['sent_to_underwriting'], stageTarget: 'Underwriting', engine: 'sentToUnderwriting' },
  { key: 'prepped', label: 'Offers prepped', kinds: ['offer_prepped'], stageTarget: 'Give offer', engine: 'offersPrepped' },
  { key: 'sent', label: 'Offers sent', kinds: ['offer_sent'], stageTarget: 'Offer sent', engine: 'offersSent' },
  { key: 'hot', label: 'Hot leads', kinds: ['hot_lead'], engine: 'hotLeads' },
  { key: 'evalfailed', label: 'Evals failed', kinds: ['eval_failed'], engine: 'evalsFailed' },
  { key: 'contract', label: 'Under contract', kinds: ['under_contract'], stageTarget: 'Under contract' },
  { key: 'assigned', label: 'Assigned', kinds: ['assigned'], stageTarget: 'Assigned' },
]

const KIND_LABELS: Record<string, string> = {
  reachout: 'Reach-out',
  outbound_msg: 'Outbound SMS',
  inbound_msg: 'Inbound SMS',
  msg_activity: 'Message activity',
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

function metaOf(meta: string | null): Record<string, unknown> | null {
  if (!meta) return null
  try {
    const m = JSON.parse(meta) as Record<string, unknown>
    return m && typeof m === 'object' ? m : null
  } catch {
    return null
  }
}

function metaAddr(meta: string | null): string | null {
  const a = metaOf(meta)?.addr
  return typeof a === 'string' && a ? a : null
}

/** Human-readable "what happened" for a row — stage targets parsed from
 *  stage_move values ("From->To"), stat_* ids are intake bookkeeping. */
function stepLabel(r: ActivityRow): string {
  if (r.kind === 'stage_move' && r.value) {
    if (r.value.includes('->')) {
      const target = r.value.split('->').pop()!.trim()
      return `→ ${target}`
    }
    if (r.value.startsWith('stat_')) return 'Status update'
    return `→ ${r.value}`
  }
  if (r.kind === 'convo' && r.value) return `Conversation: ${r.value}`
  if (r.kind === 'human_attention' && r.value) return r.value.slice(0, 80)
  return kindLabel(r.kind)
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

  const since = useMemo(() => sinceFor(win), [win])

  // One composite action per poll — a single server-action POST resolves
  // metrics + activity summary + rows + queue concurrently (previously
  // four separate POSTs each re-validating the session).
  useEffect(() => {
    let cancelled = false
    const load = () =>
      analyticsView(since).then((r) => {
        if (cancelled || !r.ok) return
        setMetrics(r.metrics)
        setCounts(r.counts)
        setRows(r.rows)
        setQueue(r.queueItems)
      })
    load()
    const t = setInterval(load, ROW_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [since])

  const jobByLead = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of queue) {
      const j = jobIdForItem(i)
      if (i.leadId && j) m.set(i.leadId, j)
    }
    return m
  }, [queue])

  const queueAddrByLead = useMemo(() => {
    const m = new Map<string, string>()
    for (const i of queue) if (i.leadId && i.address) m.set(i.leadId, i.address)
    return m
  }, [queue])

  // Resolve the best property address per lead: event's propertyAddress
  // or meta.addr first (any event for the lead), queue address as fallback.
  const addrByLead = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows ?? []) {
      if (!r.leadId || m.has(r.leadId)) continue
      const addr = r.propertyAddress ?? metaAddr(r.meta)
      if (addr) m.set(r.leadId, addr)
    }
    for (const r of rows ?? []) {
      if (r.leadId && !m.has(r.leadId)) {
        const addr = queueAddrByLead.get(r.leadId)
        if (addr) m.set(r.leadId, addr)
      }
    }
    return m
  }, [rows, queueAddrByLead])

  const hasActivity = useMemo(() => !!counts && Object.values(counts).some((n) => n > 0), [counts])

  // Engine funnel metrics are authoritative for the headline counts
  // (they dedupe per-lead); our D1 store powers the drill-down rows and
  // fills in when the engine has no equivalent metric (or is down).
  const tileCount = useCallback(
    (t: Tile): number | null => {
      const v = t.engine != null ? metrics?.[t.engine] : null
      if (typeof v === 'number') return v
      if (hasActivity && counts) {
        return t.kinds.reduce((sum, k) => sum + (counts[k] ?? 0), 0)
      }
      return null
    },
    [counts, hasActivity, metrics],
  )

  const convRate = useMemo(() => {
    if (metrics?.responseRatePct != null) return Math.round(metrics.responseRatePct)
    if (hasActivity && counts) {
      const sent = (counts['reachout'] ?? 0) + (counts['outbound_msg'] ?? 0)
      const got = (counts['response'] ?? 0) + (counts['inbound_msg'] ?? 0)
      return sent > 0 ? Math.round((got / sent) * 100) : null
    }
    return null
  }, [counts, hasActivity, metrics])

  const select = (t: Tile) => setSelected(selected?.key === t.key ? null : t)

  // msg_activity is the raw per-message timestamp feed — duplicates the
  // msg rows (same acti_ id) and is excluded from display.
  const displayRows = useMemo(
    () => (rows ?? []).filter((r) => r.kind !== 'msg_activity'),
    [rows],
  )

  // Tile drill-down: matching kinds + stage_move rows landing on the
  // tile's target stage.
  const drillRows = useMemo(() => {
    if (!selected) return null
    return displayRows.filter((r) => {
      if (selected.kinds.includes(r.kind)) return true
      if (selected.stageTarget && r.kind === 'stage_move') {
        return (r.value ?? '').split('->').pop()?.trim() === selected.stageTarget
      }
      return false
    })
  }, [displayRows, selected])

  // Default feed: one row per property — address + the last step that
  // occurred. Keyed by leadId (deduped by address when no leadId).
  const latestByProperty = useMemo(() => {
    const map = new Map<string, ActivityRow>()
    for (const r of displayRows) {
      const key = r.leadId ?? r.propertyAddress ?? r.id
      const cur = map.get(key)
      if (!cur || r.ts > cur.ts) map.set(key, r)
    }
    return [...map.values()].sort((a, b) => b.ts.localeCompare(a.ts))
  }, [displayRows])

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

          {/* Drill-down — per-property latest step, or the selected tile's events */}
          <div className="border border-border/60 bg-background shadow-sm">
            <div className="px-4 py-2.5 border-b border-border/50 flex items-center justify-between">
              <div className="text-xs font-medium text-foreground-secondary">
                {selected ? `${selected.label} — event detail` : 'Latest activity by property'}
              </div>
              <div className="text-[10px] text-foreground-tertiary">
                {WINDOWS.find((w) => w.key === win)?.label}
                {rows
                  ? selected
                    ? ` · ${drillRows?.length ?? 0} events`
                    : ` · ${latestByProperty.length} properties`
                  : ''}
              </div>
            </div>
            <div className="divide-y divide-border/50">
              {rows == null ? (
                <div className="px-4 py-8 text-center text-xs text-foreground-tertiary">Loading…</div>
              ) : (selected ? (drillRows ?? []) : latestByProperty).length === 0 ? (
                <div className="px-4 py-8 flex flex-col items-center gap-2 text-center">
                  <Inbox className="w-4 h-4 text-foreground-tertiary" />
                  <div className="text-xs text-foreground-tertiary">
                    {rows.length > 0
                      ? `No ${selected ? selected.label.toLowerCase() : ''} events captured in this window — detailed per-event capture began when push went live (Sep 28).`
                      : 'No activity ingested in this window.'}
                  </div>
                </div>
              ) : (
                (selected ? (drillRows ?? []) : latestByProperty).map((r) => {
                  const jobId = r.leadId ? jobByLead.get(r.leadId) : undefined
                  const addr = r.propertyAddress ?? (r.leadId ? addrByLead.get(r.leadId) : null) ?? metaAddr(r.meta)
                  const meta = metaOf(r.meta)
                  const detail =
                    r.kind === 'stage_move' && r.value?.includes('->')
                      ? r.value
                      : typeof meta?.reason === 'string'
                        ? meta.reason
                        : typeof meta?.note === 'string'
                          ? meta.note
                          : null
                  return (
                    <div key={r.id} className="px-4 py-2 flex items-center gap-3 text-xs">
                      <div className="w-20 flex-shrink-0 text-foreground-tertiary tabular-nums">
                        <div>{fmtTime(r.ts)}</div>
                        <div className="text-[9px]">{fmtDay(r.ts)}</div>
                      </div>
                      {jobId ? (
                        <Link
                          href={`/dashboard/give-offer/${jobId}`}
                          className="w-5 h-5 rounded bg-foreground flex items-center justify-center flex-shrink-0 hover:opacity-80 transition-opacity"
                          title="Open property in Offers"
                        >
                          <FlowGlyph className="w-3 h-3 text-background" />
                        </Link>
                      ) : (
                        <span
                          className="w-5 h-5 rounded bg-secondary/60 flex items-center justify-center flex-shrink-0"
                          title="Not underwritten yet"
                        >
                          <FlowGlyph className="w-3 h-3 text-foreground-tertiary" />
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        {r.leadId ? (
                          <a
                            href={`https://app.close.com/lead/${r.leadId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="truncate block text-foreground-primary font-medium hover:text-primary hover:underline"
                            title="Open in Close"
                          >
                            {addr ?? '—'}
                          </a>
                        ) : (
                          <div className="truncate text-foreground-primary font-medium">{addr ?? '—'}</div>
                        )}
                        <div className="text-[10px] text-foreground-tertiary truncate" title={detail ?? undefined}>
                          {stepLabel(r)}
                          {detail && detail !== stepLabel(r) ? ` · ${detail.slice(0, 70)}` : ''}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
