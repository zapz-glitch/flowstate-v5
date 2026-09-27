'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronDown, PlusCircle } from 'lucide-react'

// ─── Realtor notes ───────────────────────────────────────────────────────────
//
// Conversational-AI notes pulled from the Close lead (FLOWSTATE CONVERSATION
// LOG entries) plus any rehab intel classified from them. Notes can add to
// the renovation ledger — removals are advisory callouts only.

export interface RealtorNoteEntry {
  id: string
  createdAt: string
  text: string
}

export interface RehabAdvisoryEntry {
  itemId: string | null
  item: string
  suggestion: 'consider_removing' | 'informational'
  note: string
  evidence: string
}

export interface RehabAdditionEntry {
  itemId: string | null
  item: string
  estimatedCost: number
  evidence: string
}

const fmtMoney = (n: number) =>
  `$${Math.round(n).toLocaleString()}`

function NoteLine({ text }: { text: string }) {
  // Entries arrive as `YYYY-MM-DD <content>` — split the date chip from text.
  const m = /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(text)
  return (
    <li className="flex items-start gap-2 text-[11px] leading-relaxed">
      {m ? (
        <>
          <span className="text-foreground-tertiary tabular-nums flex-shrink-0 pt-px">{m[1]}</span>
          <span className="text-foreground-secondary">{m[2]}</span>
        </>
      ) : (
        <span className="text-foreground-secondary">{text}</span>
      )}
    </li>
  )
}

export function RealtorNotesCard({
  notes,
  advisories,
  additions,
  fetchedAt,
}: {
  notes: RealtorNoteEntry[]
  advisories?: RehabAdvisoryEntry[] | null
  additions?: RehabAdditionEntry[] | null
  fetchedAt?: string | null
}) {
  const [showAll, setShowAll] = useState(false)
  if (notes.length === 0 && !advisories?.length && !additions?.length) return null

  const visible = showAll ? notes : notes.slice(0, 5)
  const fetchedLabel = fetchedAt
    ? `pulled ${new Date(fetchedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : null

  return (
    <section className="border border-border rounded-sm px-4 py-3 space-y-2 text-foreground break-words">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-body-sm font-semibold">Realtor notes</h3>
        <div className="flex items-center gap-2">
          {notes.length > 5 && (
            <button
              type="button"
              onClick={() => setShowAll((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-foreground-tertiary hover:text-foreground"
            >
              {showAll ? 'Show fewer' : `All ${notes.length} notes`}
              <ChevronDown className={`w-3 h-3 transition-transform ${showAll ? 'rotate-180' : ''}`} />
            </button>
          )}
          {fetchedLabel && (
            <span className="text-[10px] text-foreground-tertiary">{fetchedLabel}</span>
          )}
        </div>
      </div>

      {notes.length > 0 && (
        <ul className="space-y-1.5">
          {visible.map((n, i) => (
            <NoteLine key={`${n.id}-${i}`} text={n.text} />
          ))}
        </ul>
      )}

      {additions && additions.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-border/30">
          {additions.map((a, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] text-emerald-500">
              <PlusCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>
                Added {a.item} +{fmtMoney(a.estimatedCost)} to renovation
                <span className="text-foreground-tertiary"> — {a.evidence}</span>
              </span>
            </p>
          ))}
        </div>
      )}

      {advisories && advisories.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-border/30">
          {advisories.map((a, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[11px] text-amber-500">
              <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>
                {a.suggestion === 'consider_removing'
                  ? `Consider removing ${a.item} from renovation`
                  : a.item}
                {a.note ? ` — ${a.note}` : ''}
                <span className="text-foreground-tertiary">{a.evidence ? ` (${a.evidence})` : ''}</span>
              </span>
            </p>
          ))}
        </div>
      )}
    </section>
  )
}
