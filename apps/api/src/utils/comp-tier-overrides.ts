/**
 * Manual comp-tier overrides — reviewer's ARV/as-is pins on a job's comps.
 * Applied at read time onto each comp (`userTier`) and the report's jev
 * block (`userOverrides`) so the assignment is visible on cache hits and
 * saved reports; Jev's classification itself is never rewritten.
 */
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { compTierOverrides } from '../db/schema';
import type { Env } from '../types';

export async function applyCompTierOverrides(
  env: Env,
  userId: string,
  jobId: string,
  result: unknown,
): Promise<void> {
  if (!result || typeof result !== 'object') return;
  const db = drizzle(env.DB);
  const overrides = await db
    .select({ compId: compTierOverrides.compId, tier: compTierOverrides.tier })
    .from(compTierOverrides)
    .where(and(eq(compTierOverrides.jobId, jobId), eq(compTierOverrides.userId, userId)));
  const r = result as Record<string, unknown>;
  const jev = (r.report as { jev?: Record<string, unknown> } | undefined)?.jev;
  if (jev && typeof jev === 'object') jev.userOverrides = overrides;
  if (overrides.length === 0) return;
  const byComp = new Map(overrides.map((o) => [o.compId, o.tier]));
  const items =
    (r.comps as { items?: unknown[] } | undefined)?.items ?? (r.comparables as unknown[] | undefined);
  if (!Array.isArray(items)) return;
  for (const comp of items) {
    if (!comp || typeof comp !== 'object') continue;
    const rec = comp as Record<string, unknown>;
    const tier = byComp.get(String(rec.id ?? rec.compId ?? ''));
    if (tier) rec.userTier = tier;
    else delete rec.userTier;
  }
}
