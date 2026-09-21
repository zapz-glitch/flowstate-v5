/**
 * SSE Token Utilities
 *
 * HMAC-SHA256 signed tokens for authenticating SSE stream connections.
 * Tokens are short-lived (5 minutes) to prevent replay attacks.
 */

import { timingSafeEqual } from '../lib/share-token'

const TOKEN_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

async function hmacSign(secret: string, data: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Generate a signed SSE token for a given job ID and user.
 * Token format: base64(JSON({ jobId, userId, exp })).signature
 */
export async function generateSseToken(
  secret: string,
  jobId: string,
  userId: string,
): Promise<string> {
  const payload = {
    jobId,
    userId,
    exp: Date.now() + TOKEN_EXPIRY_MS,
  }
  const payloadStr = btoa(JSON.stringify(payload))
  const signature = await hmacSign(secret, payloadStr)
  return `${payloadStr}.${signature}`
}

/**
 * Verify and decode an SSE token.
 * Returns the payload if valid, null if expired or invalid.
 */
export async function verifySseToken(
  secret: string,
  token: string,
): Promise<{ jobId: string; userId: string; exp: number } | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [payloadStr, providedSig] = parts
  const expectedSig = await hmacSign(secret, payloadStr)

  if (!timingSafeEqual(providedSig, expectedSig)) return null

  try {
    const payload = JSON.parse(atob(payloadStr)) as { jobId: string; userId: string; exp: number }
    if (payload.exp < Date.now()) return null
    return payload
  } catch {
    return null
  }
}
