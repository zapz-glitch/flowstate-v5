/**
 * Crypto helpers for password-protected report sharing.
 * Uses Web Crypto API (Cloudflare Workers compatible).
 */

/** Constant-time hex-string comparison — avoids timing leaks on secrets. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ─── Password Hashing ────────────────────────────────────────────────────────

/** Hash a password with a random salt. Returns "salt:sha256hex". */
export async function hashSharePassword(password: string): Promise<string> {
  const salt = crypto.randomUUID()
  const data = new TextEncoder().encode(salt + password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `${salt}:${hashHex}`
}

/** Verify a password against a stored "salt:sha256hex" hash. */
export async function verifySharePassword(
  password: string,
  stored: string
): Promise<boolean> {
  const colonIdx = stored.indexOf(':')
  if (colonIdx === -1) return false
  const salt = stored.slice(0, colonIdx)
  const expectedHash = stored.slice(colonIdx + 1)
  const data = new TextEncoder().encode(salt + password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return timingSafeEqual(hashHex, expectedHash)
}

// ─── HMAC-Signed Access Tokens ───────────────────────────────────────────────

interface TokenPayload {
  /** jobId */
  j: string
  /** expiry timestamp (ms) */
  e: number
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

/** Sign a token payload. Returns "base64payload.base64sig". */
export async function signAccessToken(
  jobId: string,
  secret: string,
  ttlMs: number = 24 * 60 * 60 * 1000
): Promise<string> {
  const payload: TokenPayload = { j: jobId, e: Date.now() + ttlMs }
  const payloadStr = btoa(JSON.stringify(payload))
  const key = await getHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadStr))
  const sigStr = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return `${payloadStr}.${sigStr}`
}

/** Verify an access token. Returns the jobId if valid, null otherwise. */
export async function verifyAccessToken(
  token: string,
  secret: string
): Promise<string | null> {
  const dotIdx = token.indexOf('.')
  if (dotIdx === -1) return null
  const payloadStr = token.slice(0, dotIdx)
  const sigStr = token.slice(dotIdx + 1)
  try {
    const key = await getHmacKey(secret)
    const sig = Uint8Array.from(atob(sigStr), (c) => c.charCodeAt(0))
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      sig,
      new TextEncoder().encode(payloadStr)
    )
    if (!valid) return null
    const payload: TokenPayload = JSON.parse(atob(payloadStr))
    if (Date.now() > payload.e) return null // expired
    return payload.j
  } catch {
    return null
  }
}
