/**
 * Offline data cache backed by IndexedDB.
 *
 * client-api.ts uses this as a network-first fallback: every successful GET
 * response is stored here keyed by request path, so when the network/API is
 * unreachable the dashboard can still render the last-known data instead of
 * an error. Entries older than MAX_AGE_MS are treated as absent.
 */

const DB_NAME = 'flowstate-offline'
const STORE_NAME = 'api'
const MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000 // 21 days — mirrors API KV TTL

interface CacheEntry {
  data: unknown
  ts: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbSupported(): boolean {
  return typeof indexedDB !== 'undefined'
}

export async function offlineGet<T>(key: string): Promise<T | null> {
  if (!idbSupported()) return null
  try {
    const db = await openDb()
    const entry = await new Promise<CacheEntry | undefined>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
      req.onsuccess = () => resolve(req.result as CacheEntry | undefined)
      req.onerror = () => reject(req.error)
    })
    db.close()
    if (!entry || Date.now() - entry.ts > MAX_AGE_MS) return null
    return entry.data as T
  } catch {
    return null
  }
}

export async function offlineSet(key: string, data: unknown): Promise<void> {
  if (!idbSupported()) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const req = db
        .transaction(STORE_NAME, 'readwrite')
        .objectStore(STORE_NAME)
        .put({ data, ts: Date.now() } satisfies CacheEntry, key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    db.close()
  } catch {
    // Offline cache is best-effort — never let a cache write break a request
  }
}

export async function offlineClear(): Promise<void> {
  if (!idbSupported()) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear()
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    db.close()
  } catch {
    // best-effort
  }
}
