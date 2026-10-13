/**
 * V4 engine tags. 'python-v4' was renamed 'eval-v4' — every report saved
 * before the rename still carries the old tag in its stored JSON, so
 * readers must accept both. Emitters write 'eval-v4'.
 */
export const V4_ENGINE_TAGS: ReadonlySet<string> = new Set(['eval-v4', 'python-v4'])

/** Is this report's engine tag the V4 (server-seated) engine — either name. */
export function isV4Engine(engine: string | null | undefined): boolean {
  return engine != null && V4_ENGINE_TAGS.has(engine)
}
