/**
 * Progress messages for the subject's permit lookup, sent over the job's existing progress channel
 * (`eval_progress`) so the dashboard can show the permit stages the way it shows the comp stages.
 * Each message carries `stage` so the dashboard can tell it from the evaluation's own messages.
 *
 *   requesting → received (found / none / unavailable) → assessed (major items charged from them)
 */

export type PermitStage = 'requesting' | 'received' | 'assessed'
export type PermitState = 'ok' | 'empty' | 'unavailable'

export interface PermitProgress {
  message: string
  data: { stage: PermitStage; state?: PermitState; count?: number }
}

type PermitLookup =
  | { success: true; data?: { permits?: unknown[]; count?: number } | null }
  | { success: false; error?: string }
  | null
  | undefined

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function permitsRequested(): PermitProgress {
  return { message: 'Requesting permit records', data: { stage: 'requesting' } }
}

/** What the lookup came back with: how many permits, none on file, or the lookup failed (which does not mean none exist). */
export function permitsReceived(result: PermitLookup): PermitProgress {
  if (!result || result.success !== true) {
    return { message: 'Permit lookup unavailable', data: { stage: 'received', state: 'unavailable' } }
  }
  const count = result.data?.count ?? result.data?.permits?.length ?? 0
  return count > 0
    ? { message: `${plural(count, 'permit')} found`, data: { stage: 'received', state: 'ok', count } }
    : { message: 'No permits on file', data: { stage: 'received', state: 'empty', count: 0 } }
}

/** After the permit-age engine has run: how many major items it charged. Nothing to say when there were no permits. */
export function permitsAssessed(permitCount: number, chargedItems: number): PermitProgress | null {
  if (permitCount <= 0) return null
  return {
    message: chargedItems > 0 ? `Major items assessed from permits · ${chargedItems} charged` : 'Major items assessed from permits · none charged',
    data: { stage: 'assessed', count: chargedItems },
  }
}
