/**
 * The permit lookup's stages, shown the way the comp stages are: one label that updates in place,
 * with a small step marker. Stages come from the server's progress messages during an analysis
 * (`eval_progress` carrying `stage: 'permits'`) and from the browser itself during an on-demand pull.
 *
 *   requesting → received (found / none / unavailable) → assessed (major items charged from them)
 */

export type PermitStage = 'requesting' | 'received' | 'assessed'
export type PermitState = 'ok' | 'empty' | 'unavailable'

export interface PermitProgress {
  stage: PermitStage
  message: string
  state?: PermitState
  count?: number
}

export const PERMIT_STAGES: readonly PermitStage[] = ['requesting', 'received', 'assessed']

const isStage = (value: unknown): value is PermitStage => PERMIT_STAGES.includes(value as PermitStage)
const isState = (value: unknown): value is PermitState => value === 'ok' || value === 'empty' || value === 'unavailable'

/** A progress message from the server, if it is about permits (anything else is the evaluation's own and is left alone). */
export function permitProgressFromEvent(data: unknown): PermitProgress | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (!isStage(d.stage) || typeof d.message !== 'string') return null
  return {
    stage: d.stage,
    message: d.message,
    state: isState(d.state) ? d.state : undefined,
    count: typeof d.count === 'number' ? d.count : undefined,
  }
}

/** Which step (1 to 3) the lookup is on */
export const permitStep = (progress: PermitProgress): number => PERMIT_STAGES.indexOf(progress.stage) + 1

/**
 * Nothing more is coming: major items have been assessed, or the lookup found nothing (or could not
 * run), so there are no items to assess.
 */
export const permitProgressDone = (progress: PermitProgress): boolean =>
  progress.stage === 'assessed' || (progress.stage === 'received' && progress.state !== undefined && progress.state !== 'ok')

/** The stages of an on-demand pull, from what the browser can see for itself */
export const pullRequesting = (): PermitProgress => ({ stage: 'requesting', message: 'Requesting permit records' })

export const pullReceived = (count: number): PermitProgress =>
  count > 0
    ? { stage: 'received', state: 'ok', count, message: `${count} permit${count === 1 ? '' : 's'} found` }
    : { stage: 'received', state: 'empty', count: 0, message: 'No permits on file' }

export const pullApplied = (): PermitProgress => ({ stage: 'assessed', message: 'Major items and valuation updated' })
