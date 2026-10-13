'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { X, FileText, CheckCircle2, ArrowLeftRight, PenLine, FileCheck2, CircleDollarSign, CircleSlash2, ExternalLink } from 'lucide-react'
import { getOfferBoard, removeOfferBoardItem, type BoardItem } from '@/app/(dashboard)/dashboard/give-offer/actions'

const POLL_MS = 10_000

/** Column order — the campaign stages in flow order. A stage outside
 *  this list (custom_*) appends its own column at the end. */
const STAGES: { key: string; label: string; icon: React.ReactNode; tint: string }[] = [
  { key: 'approved', label: 'Approved', icon: <CheckCircle2 size={12} />, tint: 'text-emerald-500' },
  { key: 'awaiting_contract', label: 'Awaiting contract', icon: <FileCheck2 size={12} />, tint: 'text-yellow-500' },
  { key: 'countered', label: 'Countered', icon: <ArrowLeftRight size={12} />, tint: 'text-orange-500' },
  { key: 'sent', label: 'Offer sent', icon: <FileText size={12} />, tint: 'text-blue-400' },
  { key: 'under_contract', label: 'Under contract', icon: <CircleDollarSign size={12} />, tint: 'text-emerald-600' },
  { key: 'dead', label: 'Dead', icon: <CircleSlash2 size={12} />, tint: 'text-red-500/70' },
  { key: 'terms_prep', label: 'Terms in prep', icon: <PenLine size={12} />, tint: 'text-foreground-tertiary' },
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

/** Close CRM deep link — the contact record behind the address. */
const closeLeadUrl = (leadId: string | null | undefined) =>
  leadId ? `https://app.close.com/lead/${leadId}/` : null

/** Address → the offer report when one exists, else Property Search
 *  prefilled with the address (kicks off the eval). Every address
 *  is a link. */
const reportHref = (i: BoardItem) =>
  i.reportJobId ? `/dashboard/give-offer/${i.reportJobId}` : `/dashboard/analyze?address=${encodeURIComponent(i.address)}`

/** Legit link feel — color shift on hover (the Property Search
 *  transition), no underline. */
const ADDR_LINK = 'text-foreground hover:text-primary transition-colors truncate'

export function OfferBoard() {
  const [items, setItems] = useState<BoardItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [view, setView] = useState<'board' | 'list'>('board')
  const [listStage, setListStage] = useState<string>('all')
  const [listQuery, setListQuery] = useState('')
  const [listDays, setListDays] = useState<string>('ytd')

  const load = useCallback(async (all: boolean) => {
    const r = await getOfferBoard(all).catch(() => null)
    // Only swap state when the data changed — an identical poll result
    // re-rendering the board is the offers-page flicker.
    if (r?.ok) {
      const sig = (arr: BoardItem[]) =>
        arr.map((i) => `${i.id}:${i.status}:${i.updatedAt}:${i.counterAmount}:${i.note ?? ''}:${i.dismissed ? 1 : 0}`).join('|')
      setItems((prev) => sig(prev) === sig(r.items) ? prev : r.items)
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    load(showAll)
    const t = setInterval(() => load(showAll), POLL_MS)
    return () => clearInterval(t)
  }, [load, showAll])

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, dismissed: true } : i))
    removeOfferBoardItem(id).catch(() => null)
  }, [])

  const live = items.filter((i) => !i.dismissed)
  const columns = useMemo(() => {
    const groups = new Map<string, BoardItem[]>()
    for (const s of STAGES) groups.set(s.key, [])
    for (const i of items) {
      if (!groups.has(i.status)) groups.set(i.status, [])
      groups.get(i.status)!.push(i)
    }
    return [...groups.entries()].filter(([, arr]) => arr.length > 0)
  }, [items])

  // Airtable-style list — same items, filter by stage + recency + free text.
  const listRows = useMemo(() => {
    const q = listQuery.trim().toLowerCase()
    const now = Date.now()
    const since = listDays === 'all' ? null
      : listDays === 'today' ? now - (now % 86400000) - new Date().getTimezoneOffset() * 60000
      : listDays === 'ytd' ? new Date(new Date().getFullYear(), 0, 1).getTime()
      : now - Number(listDays) * 86400000
    return items.filter((i) => {
      if (listStage !== 'all' && i.status !== listStage) return false
      if (since != null && Date.parse(i.updatedAt) < since) return false
      if (!q) return true
      return [i.address, i.displayName, i.note]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
    })
  }, [items, listStage, listQuery, listDays])

  if (loaded && items.length === 0) return null

  return (
    <div className="border border-border/60 bg-background rounded-md shadow-sm">
      <div className="px-3 py-2 border-b border-border/40 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
          Campaign board
        </span>
        <span className="text-[10px] text-foreground-tertiary tabular-nums">{live.length} live</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setView('board')}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              view === 'board' ? 'border-primary/60 text-foreground bg-primary/10' : 'border-border/60 text-foreground-tertiary hover:text-foreground'
            }`}
          >
            Board
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              view === 'list' ? 'border-primary/60 text-foreground bg-primary/10' : 'border-border/60 text-foreground-tertiary hover:text-foreground'
            }`}
          >
            List
          </button>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              showAll ? 'border-primary/60 text-foreground bg-primary/10' : 'border-border/60 text-foreground-tertiary hover:text-foreground'
            }`}
          >
            {showAll ? 'All time' : 'Live only'}
          </button>
        </span>
      </div>

      {view === 'list' ? (
        <div className="p-2 space-y-1.5">
          {/* Filter bar — stage + recency selects, free text */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={listStage}
              onChange={(e) => setListStage(e.target.value)}
              aria-label="Stage"
              className="bg-secondary border border-border rounded-md px-2 py-1 text-[11px] text-foreground outline-none focus:border-primary/50 [color-scheme:dark]"
            >
              <option value="all">All stages</option>
              {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <select
              value={listDays}
              onChange={(e) => setListDays(e.target.value)}
              aria-label="Period"
              className="bg-secondary border border-border rounded-md px-2 py-1 text-[11px] text-foreground outline-none focus:border-primary/50 [color-scheme:dark]"
            >
              <option value="ytd">Year to date</option>
              <option value="all">All time</option>
            </select>
            <span className="text-[10px] text-foreground-tertiary tabular-nums">{listRows.length} shown</span>
            <input
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="Filter…"
              className="ml-auto w-36 bg-secondary/50 border border-border/50 rounded-md px-2 py-1 text-[11px] text-foreground placeholder:text-foreground-tertiary outline-none focus:border-primary/50"
            />
          </div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-foreground-tertiary border-b border-border/40">
                <th className="py-1 pr-3 font-medium">Address</th>
                <th className="py-1 pr-3 font-medium">Contact</th>
                <th className="py-1 pr-3 font-medium">Stage</th>
                <th className="py-1 pr-3 font-medium text-right">Offer</th>
                <th className="py-1 pr-3 font-medium text-right">Counter</th>
                <th className="py-1 pr-3 font-medium">Note</th>
                <th className="py-1 font-medium text-right">Updated</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {listRows.map((i) => {
                const contact = closeLeadUrl(i.leadId)
                return (
                  <tr key={i.id} className={`border-b border-border/20 group ${i.dismissed ? 'opacity-50' : ''}`}>
                    <td className="py-1.5 pr-3 max-w-[220px] truncate">
                      <Link href={reportHref(i)} className={ADDR_LINK}>
                        {i.address}
                      </Link>
                    </td>
                    <td className="py-1.5 pr-3">
                      {contact ? (
                        <a href={contact} target="_blank" rel="noreferrer" className="text-foreground-tertiary hover:text-foreground hover:underline">
                          {i.displayName ?? 'Open'}
                        </a>
                      ) : (i.displayName ?? '—')}
                    </td>
                    <td className="py-1.5 pr-3">
                      <span className={`${STAGES.find((s) => s.key === i.status)?.tint ?? 'text-foreground-tertiary'}`}>
                        {stageLabel(i.status)}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-foreground-secondary">{fmtPrice(i.offerAmount) ?? '—'}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-orange-500">{fmtPrice(i.counterAmount) ?? '—'}</td>
                    <td className="py-1.5 pr-3 max-w-[200px] truncate text-foreground-secondary" title={i.note ?? ''}>{i.note ?? '—'}</td>
                    <td className="py-1.5 text-right tabular-nums text-foreground-tertiary">{fmtAge(i.updatedAt)}</td>
                    <td className="py-1.5 pl-2">
                      {!i.dismissed && (
                        <button
                          type="button"
                          onClick={() => remove(i.id)}
                          title="Remove from board"
                          className="opacity-0 group-hover:opacity-100 text-foreground-tertiary hover:text-foreground transition-opacity"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {listRows.length === 0 && (
                <tr><td colSpan={8} className="py-4 text-center text-foreground-tertiary">No items match</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
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
                {arr.map((i) => {
                  const contact = closeLeadUrl(i.leadId)
                  return (
                    <div
                      key={i.id}
                      className={`group border rounded-md px-2.5 py-2 relative ${
                        i.dismissed
                          ? 'border-border/30 bg-secondary/10 opacity-50'
                          : 'border-border/50 bg-secondary/30'
                      }`}
                    >
                      {!i.dismissed && (
                        <button
                          type="button"
                          onClick={() => remove(i.id)}
                          title="Remove from board"
                          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 text-foreground-tertiary hover:text-foreground transition-opacity"
                        >
                          <X size={12} />
                        </button>
                      )}
                      <div className="text-xs font-medium pr-4 truncate" title={i.address}>
                        <Link href={reportHref(i)} className={ADDR_LINK}>
                          {i.address}
                        </Link>
                      </div>
                      <div className="text-[10px] text-foreground-tertiary mt-0.5 flex items-center gap-2 flex-wrap">
                        {contact && (
                          <a href={contact} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline truncate">
                            {i.displayName ?? 'Close contact'}
                          </a>
                        )}
                        {!contact && i.displayName && <span className="truncate">{i.displayName}</span>}
                        {fmtPrice(i.offerAmount) && <span>offer {fmtPrice(i.offerAmount)}</span>}
                        {fmtPrice(i.counterAmount) && <span className="text-orange-500">counter {fmtPrice(i.counterAmount)}</span>}
                        <span className="tabular-nums ml-auto">{fmtAge(i.updatedAt)}</span>
                      </div>
                      {i.note && (
                        <div className="text-[10px] text-foreground-secondary mt-1 line-clamp-2">{i.note}</div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
        {!loaded && <div className="text-xs text-foreground-tertiary px-2 py-4">Loading board…</div>}
      </div>
      )}
    </div>
  )
}
