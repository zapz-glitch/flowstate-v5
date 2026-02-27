/**
 * WebSocket Authentication Token Utility
 *
 * Implements industry-standard short-lived signed tokens for WebSocket authentication.
 * Uses HMAC-SHA256 for signing, following best practices from:
 * - RFC 8725 (JSON Web Token Best Current Practices)
 * - OWASP WebSocket Security Guidelines
 *
 * Security features:
 * - Short-lived tokens (5 minute expiry by default)
 * - HMAC-SHA256 signature prevents tampering
 * - Tokens are scoped to specific user and job
 * - Origin validation recommended at connection time
 */

// Token validity in milliseconds (5 minutes)
const TOKEN_VALIDITY_MS = 5 * 60 * 1000

interface WebSocketTokenPayload {
  /** User ID */
  uid: string
  /** Job ID */
  jid: string
  /** Property key for DO lookup */
  pk: string
  /** Issued at timestamp (ms) */
  iat: number
  /** Expiry timestamp (ms) */
  exp: number
}

/**
 * Generate HMAC-SHA256 signature using Web Crypto API
 */
async function sign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

/**
 * Verify HMAC-SHA256 signature using Web Crypto API
 */
async function verify(data: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )

  // Convert URL-safe base64 back to standard base64
  const normalizedSig = signature.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (normalizedSig.length % 4)) % 4)
  const sigBytes = Uint8Array.from(atob(normalizedSig + padding), (c) => c.charCodeAt(0))

  return crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(data))
}

/**
 * Generate a short-lived WebSocket authentication token
 *
 * @param userId - User ID
 * @param jobId - Job ID
 * @param propertyKey - Property key for DO lookup
 * @param secret - Server secret for signing
 * @param validityMs - Token validity in milliseconds (default 5 minutes)
 * @returns Signed token string
 */
export async function generateWsToken(
  userId: string,
  jobId: string,
  propertyKey: string,
  secret: string,
  validityMs: number = TOKEN_VALIDITY_MS
): Promise<string> {
  const now = Date.now()
  const payload: WebSocketTokenPayload = {
    uid: userId,
    jid: jobId,
    pk: propertyKey,
    iat: now,
    exp: now + validityMs,
  }

  // Encode payload as URL-safe base64
  const payloadStr = JSON.stringify(payload)
  const encodedPayload = btoa(payloadStr)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')

  // Sign the payload
  const signature = await sign(encodedPayload, secret)

  // Return token as payload.signature
  return `${encodedPayload}.${signature}`
}

/**
 * Verify and decode a WebSocket authentication token
 *
 * @param token - Token string to verify
 * @param secret - Server secret for verification
 * @returns Decoded payload if valid, null if invalid or expired
 */
export async function verifyWsToken(
  token: string,
  secret: string
): Promise<WebSocketTokenPayload | null> {
  try {
    const [encodedPayload, signature] = token.split('.')

    if (!encodedPayload || !signature) {
      console.error('[WS Token] Invalid token format')
      return null
    }

    // Verify signature
    const isValid = await verify(encodedPayload, signature, secret)
    if (!isValid) {
      console.error('[WS Token] Invalid signature')
      return null
    }

    // Decode payload
    const normalizedPayload = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const padding = '='.repeat((4 - (normalizedPayload.length % 4)) % 4)
    const payloadStr = atob(normalizedPayload + padding)
    const payload: WebSocketTokenPayload = JSON.parse(payloadStr)

    // Check expiry (silently reject expired tokens)
    if (Date.now() > payload.exp) {
      return null
    }

    return payload
  } catch (error) {
    console.error('[WS Token] Verification error:', error)
    return null
  }
}

/**
 * Extract token payload without verification (for logging/debugging)
 * DO NOT use for authentication - always use verifyWsToken
 */
export function decodeWsTokenUnsafe(token: string): WebSocketTokenPayload | null {
  try {
    const [encodedPayload] = token.split('.')
    if (!encodedPayload) return null

    const normalizedPayload = encodedPayload.replace(/-/g, '+').replace(/_/g, '/')
    const padding = '='.repeat((4 - (normalizedPayload.length % 4)) % 4)
    const payloadStr = atob(normalizedPayload + padding)
    return JSON.parse(payloadStr)
  } catch {
    return null
  }
}
