// A ?address= link (browser extension / shared link) has to survive sign-in:
// the auth guard sends signed-out visitors to "/", which drops the query.
const KEY = 'fs-pending-address'
const ANALYZE_PATH = '/dashboard/analyze'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function stashPendingAddress(pathname: string, search: string, store?: Store): void {
  if (pathname !== ANALYZE_PATH) return
  const address = new URLSearchParams(search).get('address')?.trim()
  if (!address) return
  try {
    (store ?? window.sessionStorage).setItem(KEY, address)
  } catch {
    // Storage blocked — the user lands on a blank analyze page, as before.
  }
}

/** Where to go after sign-in; consumes the stashed address so it runs once. */
export function takePostSignInPath(store?: Store): string {
  try {
    const target = store ?? window.sessionStorage
    const address = target.getItem(KEY)
    target.removeItem(KEY)
    if (address) return `${ANALYZE_PATH}?address=${encodeURIComponent(address)}`
  } catch {
    // Storage blocked — fall through to the plain analyze page.
  }
  return ANALYZE_PATH
}
