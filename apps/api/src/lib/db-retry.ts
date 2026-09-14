/**
 * Retry transient D1 failures (write contention with batch runs, dropped
 * connections to the D1 proxy). Non-transient errors throw immediately.
 */
const RETRYABLE = /SQLITE_BUSY|database is locked|network connection lost|too many requests|internal error|D1_ERROR|fetch failed/i

export async function withDbRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!RETRYABLE.test(msg) || i === attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 150 * (i + 1)))
    }
  }
  throw new Error('unreachable')
}
