/**
 * Eval-result cache helpers — shared by the analyze route, the analysis DO,
 * and the batch DO.
 *
 * Two value shapes live under one key:
 * - a bare jobId          → positive result; read saved_reports.fullResponseJson
 * - `err:<code>:<message>` → terminal verdict (insufficient comps / property
 *   not found); replay the error without spending provider calls
 */

/** 21 days — window in which a repeat evaluation with identical params returns the stored report. */
export const EVAL_RESULT_TTL_SECONDS = 21 * 24 * 60 * 60;

/** Terminal-verdict TTL — provider data can change daily, so failures expire fast. */
export const EVAL_ERROR_TTL_SECONDS = 24 * 60 * 60;

export const EVAL_ERROR_PREFIX = 'err:';

/** Stable, order-insensitive stringify for hashing eval params. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export async function hashEvalParams(params: unknown): Promise<string> {
  const data = new TextEncoder().encode(stableStringify(params));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function evalResultKey(userId: string, address: string, paramsHash: string): string {
  const norm = address.trim().toLowerCase().replace(/\s+/g, ' ');
  return `eval-result:${userId}:${norm}:${paramsHash}`;
}

/**
 * Normalize client-supplied search options for hashing — nulls mean "fall
 * through to the user's appraisal-filter defaults" (which are already covered
 * by the evalParams hash).
 */
export function searchOptionsFingerprint(
  o?: { radiusMiles?: number; maxComps?: number; monthsBack?: number } | null,
): { radiusMiles: number | null; maxComps: number | null; monthsBack: number | null } {
  return {
    radiusMiles: o?.radiusMiles ?? null,
    maxComps: o?.maxComps ?? null,
    monthsBack: o?.monthsBack ?? null,
  };
}

/** Verdicts worth caching — deterministic for the same address+params today. */
export function isCacheableVerdict(code: string | undefined): boolean {
  return code === 'INSUFFICIENT_COMPS' || code === 'PROPERTY_NOT_FOUND';
}

export function encodeVerdict(code: string, message: string): string {
  return `${EVAL_ERROR_PREFIX}${code}:${message}`;
}

export function decodeVerdict(value: string): { code: string; message: string } | null {
  if (!value.startsWith(EVAL_ERROR_PREFIX)) return null;
  const rest = value.slice(EVAL_ERROR_PREFIX.length);
  const sep = rest.indexOf(':');
  return sep === -1
    ? { code: rest, message: rest }
    : { code: rest.slice(0, sep), message: rest.slice(sep + 1) };
}
