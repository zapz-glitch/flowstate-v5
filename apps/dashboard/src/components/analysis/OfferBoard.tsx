'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, FileText, CheckCircle2, ArrowLeftRight, PenLine, FileCheck2, CircleDollarSign, CircleSlash2 } from 'lucide-react'
import { getOfferBoard, removeOfferBoardItem, type BoardItem } from '@/app/(dashboard)/dashboard/give-offer/actions'

const POLL_MS = 30_000

/** Column order — the campaign stages in flow order. A stage outside
 *  this list (custom_*) appends its own column at the end. */
const STAGES: { key: string; label: string; icon: React.ReactNode; tint: string }[] = [
  { key: 'terms_prep', label: 'Terms in prep', icon: <PenLine size={12} />, tint: 'text-foreground-tertiary' },
  { key: 'sent', label: 'Offer sent', icon: <FileText size={12} />, tint: 'text-blue-400' },
  { key: 'approved', label: 'Approved', icon: <CheckCircle2 size={12} />, tint: 'text-emerald-500' },
  { key: 'countered', label: 'Countered', icon: <ArrowLeftRight size={12} />, tint: 'text-orange-500' },
  { key: 'awaiting_contract', label: 'Awaiting contract', icon: <FileCheck2 size={12} />, tint: 'text-yellow-500' },
  { key: 'under_contract', label: 'Under contract', icon: <CircleDollarSign size={12} />, tint: 'text-emerald-600' },
  { key: 'dead', label: 'Dead', icon: <CircleSlash2 size={12} />, tint: 'text-red-500/70' },
]

const fmtPrice = (v: number | null | undefined) =>
  v == null ? null : v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`

const fmtAge = (iso: string) => {
  const mins = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000)
  if (mins < 60) return `${Math.round(mins)}m`
  if (mins < 1440) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

const stageLabel = (key: string) =>
  STAGES.find((s) => s.key === key)?.label ?? key.replace(/^(custom_)?/, '').replace(/_/g, ' ')

export function OfferBoard() {
  const [items, setItems] = useState<BoardItem[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const r = await getOfferBoard().catch(() => null)
    if (r?.ok) setItems(r.items)
    setLoaded(true)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((i) => i.id !== id))
    removeOfferBoardItem(id).catch(() => null)
  }, [])

  const columns = useMemo(() => {
    const groups = new Map<string, BoardItem[]>()
    for (const s of STAGES) groups.set(s.key, [])
    for (const i of items) {
      if (!groups.has(i.status)) groups.set(i.status, [])
      groups.get(i.status)!.push(i)
    }
    // Known stages first (in order), then any custom stages alphabetically.
    return [...groups.entries()].filter(([, arr]) => arr.length > 0)
  }, [items])

  if (loaded && items.length === 0) return null

  return (
    <div className="border border-border/60 bg-background rounded-md shadow-sm">
      <div className="px-3 py-2 border-b border-border/40 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
          Campaign board
        </span>
        <span className="text-[10px] text-foreground-tertiary tabular-nums">{items.length} live</span>
      </div>
      <div className="flex gap-2 overflow-x-auto p-2">
        {columns.map(([status, arr]) => {
          const stage = STAGES.find((s) => s.key === status)
          return (
            <div key={status} className="min-w-[180px] flex-1">
              <div className={`flex items-center gap-1.5 px-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider ${stage?.tint ?? 'text-foreground-tertiary'}`}>
                {stage?.icon}
                {stageLabel(status)}
                <span className="ml-auto tabular-nums text-foreground-tertiary">{arr.length}</span>
              </div>
              <div className="space-y-1.5">
                {arr.map((i) => (
                  <div
                    key={i.id}
                    className="group border border-border/50 rounded-md bg-secondary/30 px-2.5 py-2 relative"
                  >
                    <button
                      type="button"
                      onClick={() => remove(i.id)}
                      title="Remove from board"
                      className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-foreground-tertiary hover:text-foreground transition-opacity"
                    >
                      <X size={12} />
                    </button>
                    <div className="text-xs font-medium text-foreground pr-4 truncate" title={i.address}>
                      {i.address}
                    </div>
                    <div className="text-[10px] text-foreground-tertiary mt-0.5 flex items-center gap-2 flex-wrap">
                      {i.displayName && <span className="truncate">{i.displayName}</span>}
                      {fmtPrice(i.offerAmount) && <span>offer {fmtPrice(i.offerAmount)}</span>}
                      {fmtPrice(i.counterAmount) && <span className="text-orange-500">counter {fmtPrice(i.counterAmount)}</span>}
                      <span className="tabular-nums ml-auto">{fmtAge(i.updatedAt)}</span>
                    </div>
                    {i.note && (
                      <div className="text-[10px] text-foreground-secondary mt-1 line-clamp-2">{i.note}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
        {!loaded && <div className="text-xs text-foreground-tertiary px-2 py-4">Loading board…</div>}
      </div>
    </div>
  )
}
