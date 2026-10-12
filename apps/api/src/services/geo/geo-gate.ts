/**
 * Whether a run geocodes its subject and comps (Geocodio census lookups)
 * and stamps tract / block group on them.
 *
 * On for ATTOM runs and for both harnesses where a seat selects comps from
 * pocket evidence — corelogic (code selector) and agent (model appraiser).
 * The appraiser's geography rules are block group → neighborhood → tract;
 * without the stamps every comp reads as outside the pocket.
 */
export function isGeoGateActive(run: { isAttomMcp: boolean; harness?: 'agent' | 'corelogic' | 'typescript' | 'finale' }): boolean {
  return run.isAttomMcp || run.harness === 'corelogic' || run.harness === 'agent'
}
