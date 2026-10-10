/**
 * Per-eval API call ledger — every outbound call a job makes, counted by
 * lane so an eval reports its own spend start to finish. Lanes are named
 * after what the call is FOR (not just the provider): e.g.
 * 'corelogic:comparables', 'geocodio:comp-geocode', 'decisions:comp-digest-B',
 * 'redfin:comp-details', 'scrape:comp-listing'.
 *
 * The property-api facade records provider calls itself (per-method);
 * pipeline lanes (geo queue, digest batches, scrape budget) record at the
 * lane boundary where the batch size is known.
 */

export interface ApiLedger {
  record(lane: string, n?: number): void
  snapshot(): { lanes: Record<string, number>; total: number }
}

export function createApiLedger(): ApiLedger {
  const lanes: Record<string, number> = {}
  return {
    record(lane, n = 1) {
      lanes[lane] = (lanes[lane] ?? 0) + n
    },
    snapshot() {
      const total = Object.values(lanes).reduce((a, b) => a + b, 0)
      return { lanes, total }
    },
  }
}
