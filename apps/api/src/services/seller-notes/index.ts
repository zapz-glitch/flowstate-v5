/**
 * Seller notes — realtor/property-condition intel logged by the conversational
 * AI as Close Note activities during pre-underwriting outreach.
 *
 * Source: GET /api/v1/activity/note/?lead_id=... — notes carrying the
 * `FLOWSTATE CONVERSATION LOG` marker (body may also carry
 * `[flowstate-conversation-log:v1]`). One note often logs several entries as
 * ` -YYYY-MM-DD <text>` lines; each line becomes its own note.
 *
 * The result feeds two surfaces:
 * - `sellerNotes` on the analysis response — the raw intel for display
 * - `classifyRehabIntel` — diff notes against the derived rehab ledger:
 *   additions are applied to the valuation (never removed silently), and
 *   removal signals become advisory-only callouts for human review.
 */

import { MAJOR_ITEMS, type MajorItem, type MajorItemId } from '../valuation/types'
import { createOpenRouterProvider } from '../llm'
import type { Env } from '../../types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SellerNote {
  id: string
  createdAt: string
  /** Note content with the FLOWSTATE marker lines stripped */
  text: string
}

export interface RehabAddition {
  /** Major-item id when it maps to the known taxonomy */
  itemId: MajorItemId | null
  item: string
  estimatedCost: number
  /** The note text that evidences the need */
  evidence: string
}

export interface RehabAdvisory {
  /** Existing rehab item the note calls into question */
  itemId: MajorItemId | null
  item: string
  suggestion: 'consider_removing' | 'informational'
  note: string
  /** The note text backing this advisory */
  evidence: string
}

export interface SellerNotesResult {
  fetchedAt: string
  notes: SellerNote[]
}

// ─── Close fetch ─────────────────────────────────────────────────────────────

const CLOSE_NOTES_URL = 'https://api.close.com/api/v1/activity/note/'
const NOTE_MARKER = 'FLOWSTATE CONVERSATION LOG'
const NOTE_TAG = '[flowstate-conversation-log:v1]'
/** Entries inside a note body look like ` -2026-09-25 move-in ready, ...` */
const ENTRY_LINE = /^\s*-?\s*(\d{4}-\d{2}-\d{2})\s+(.+)$/

interface CloseNoteActivity {
  id: string
  _type?: string
  date_created?: string
  title?: string | null
  note?: string | null
}

/** Split a conversation-log note body into dated entries. */
function entriesFromBody(body: string, fallbackDate: string): string[] {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== NOTE_MARKER && !l.startsWith(NOTE_TAG))
  if (lines.length === 0) return []
  // Some notes are one line (`-2026-09-25 text`); others carry several.
  return lines
    .map((l) => {
      const m = ENTRY_LINE.exec(l)
      return m ? `${m[1]} ${m[2]}` : `${fallbackDate.slice(0, 10)} ${l}`
    })
    .filter((l) => l.trim().length > 11)
}

/**
 * Fetch conversation-log notes for a Close lead. Never throws — Close being
 * down or the key missing must not block an evaluation.
 */
export async function fetchSellerNotes(
  apiKey: string | undefined,
  leadId: string | undefined,
): Promise<SellerNote[]> {
  if (!apiKey || !leadId) return []
  try {
    const res = await fetch(
      `${CLOSE_NOTES_URL}?lead_id=${encodeURIComponent(leadId)}&_limit=100`,
      {
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Basic ${btoa(`${apiKey}:`)}`,
          Accept: 'application/json',
        },
      },
    )
    if (!res.ok) {
      console.error(`[SellerNotes] Close fetch failed: ${res.status} for ${leadId}`)
      return []
    }
    const body = (await res.json()) as { data?: CloseNoteActivity[] }
    const out: SellerNote[] = []
    for (const n of body.data ?? []) {
      const text = n.note ?? ''
      if (!text.includes(NOTE_MARKER) && !text.includes(NOTE_TAG) && !(n.title ?? '').includes(NOTE_MARKER)) {
        continue
      }
      const createdAt = n.date_created ?? new Date(0).toISOString()
      for (const entry of entriesFromBody(text, createdAt)) {
        out.push({ id: n.id, createdAt, text: entry })
      }
    }
    return out
  } catch (e) {
    console.error('[SellerNotes] fetch error:', e)
    return []
  }
}

// ─── Rehab classification ────────────────────────────────────────────────────

const MAJOR_ITEM_VOCAB = MAJOR_ITEMS.map((i) => `${i.id} (${i.name}, ~$${i.defaultCost})`).join('\n')

/**
 * Diff realtor-note intel against the enabled rehab ledger.
 *
 * Additions: note-described work that maps to a known major item NOT already
 * charged — these are applied to the valuation. Anything else that implies an
 * enabled item may be unnecessary becomes an advisory only — notes NEVER
 * remove cost automatically.
 */
export async function classifyRehabIntel(
  env: Env,
  notes: SellerNote[],
  enabledItems: Array<{ id: string; name: string; cost: number; reason: string }>,
): Promise<{ additions: RehabAddition[]; advisories: RehabAdvisory[] }> {
  const empty = { additions: [], advisories: [] }
  if (!env.OPENROUTER_API_KEY || notes.length === 0) return empty

  const enabledList = enabledItems.length
    ? enabledItems.map((i) => `${i.id} (${i.name}) — $${i.cost} — ${i.reason}`).join('\n')
    : '(none)'

  const prompt = `You are reviewing realtor/agent notes about a property's condition against the renovation cost model computed for it.

RENOVATION MAJOR ITEMS ALREADY CHARGED:
${enabledList}

KNOWN MAJOR ITEM VOCABULARY (id — name — default cost):
${MAJOR_ITEM_VOCAB}

REALTOR NOTES:
${notes.map((n) => `- "${n.text}"`).join('\n')}

Return JSON only, no prose:
{
  "additions": [ { "itemId": "<one of the vocabulary ids>", "estimatedCost": <number>, "evidence": "<the note text>" } ],
  "advisories": [ { "itemId": "<id of a CHARGED item>", "suggestion": "consider_removing", "note": "<short human-readable explanation>", "evidence": "<the note text>" } ]
}

Rules:
- additions: only items the notes clearly describe as needed (damage, age, "needs X") AND that are NOT already charged. Only use vocabulary ids. Prefer the vocabulary default cost unless the note states otherwise.
- Never add an item that is already charged.
- advisories: ONLY for notes suggesting a CHARGED item may NOT be needed (e.g. "roof 2019, no leaks" when roof is charged, "move-in ready" when items are charged). One advisory per item max.
- If a note is ambiguous, produces no addition and no advisory.
- Empty arrays are valid. Maximum 4 additions, 4 advisories.`

  try {
    const provider = createOpenRouterProvider({
      apiKey: env.OPENROUTER_API_KEY,
      model: env.OPENROUTER_MODEL ?? 'google/gemini-2.5-flash',
      maxTokens: 600,
    })
    const result = await provider.execute({
      prompt,
      responseFormat: 'json',
      temperature: 0,
    })
    if (!result.success || !result.data?.content) return empty

    const parsed = JSON.parse(
      result.data.content.replace(/^```(?:json)?\s*|\s*```$/g, ''),
    ) as {
      additions?: Array<{ itemId?: string; estimatedCost?: number; evidence?: string }>
      advisories?: Array<{ itemId?: string; suggestion?: string; note?: string; evidence?: string }>
    }

    const charged = new Set(enabledItems.map((i) => i.id))
    const vocabIds = new Set<string>(MAJOR_ITEMS.map((i) => i.id))
    const vocabName = new Map(MAJOR_ITEMS.map((i) => [i.id, i.name]))
    const vocabCost = new Map(MAJOR_ITEMS.map((i) => [i.id, i.defaultCost]))

    const additions: RehabAddition[] = (parsed.additions ?? [])
      .filter((a) => a.itemId && vocabIds.has(a.itemId) && !charged.has(a.itemId))
      .slice(0, 4)
      .map((a) => ({
        itemId: a.itemId as MajorItemId,
        item: vocabName.get(a.itemId as MajorItemId)!,
        estimatedCost:
          typeof a.estimatedCost === 'number' && a.estimatedCost > 0
            ? Math.round(a.estimatedCost)
            : vocabCost.get(a.itemId as MajorItemId)!,
        evidence: (a.evidence ?? '').slice(0, 300),
      }))

    const advisories: RehabAdvisory[] = (parsed.advisories ?? [])
      .filter((a) => a.itemId && charged.has(a.itemId))
      .slice(0, 4)
      .map((a) => ({
        itemId: a.itemId as MajorItemId,
        item: vocabName.get(a.itemId as MajorItemId) ?? a.itemId!,
        suggestion: a.suggestion === 'consider_removing' ? 'consider_removing' : 'informational',
        note: (a.note ?? '').slice(0, 300),
        evidence: (a.evidence ?? '').slice(0, 300),
      }))

    return { additions, advisories }
  } catch (e) {
    console.error('[SellerNotes] classify error:', e)
    return empty
  }
}

/** Convert a classified addition into a valuation major item. */
export function additionToMajorItem(a: RehabAddition): (MajorItem & { reason: string }) | null {
  if (!a.itemId) return null
  return {
    id: a.itemId,
    enabled: true,
    cost: a.estimatedCost,
    reason: `Realtor note: ${a.evidence}`,
  }
}
