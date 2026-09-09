const encoder = new TextEncoder()
const domain = 'flowstate:python-evaluation-snapshot:v1\n'

export interface SnapshotConfiguration {
  V4_SNAPSHOT_ACTIVE_KEY_ID?: string
  V4_SNAPSHOT_KEYS?: string
  V4_SNAPSHOT_LEGACY_KEYS?: string
}

function configuredKeys(env: SnapshotConfiguration): Record<string, string> {
  const keys = JSON.parse(env.V4_SNAPSHOT_KEYS || '{}')
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length > 8 ||
    Object.entries(keys).some(([id, value]) => !/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof value !== 'string' || value.length < 32)) {
    throw new Error('Invalid snapshot key configuration')
  }
  return keys
}

export async function signConfiguredPythonSnapshot(jobId: string, request: unknown, env: SnapshotConfiguration): Promise<string> {
  const keys = configuredKeys(env), keyId = env.V4_SNAPSHOT_ACTIVE_KEY_ID ?? ''
  if (!Object.hasOwn(keys, keyId)) throw new Error('Active snapshot signing key is not configured')
  return `v2.${keyId}.${await signPythonSnapshot(jobId, { keyId, request }, keys[keyId])}`
}

export async function verifyConfiguredPythonSnapshot(jobId: string, request: unknown, signature: string, env: SnapshotConfiguration): Promise<boolean> {
  try {
    if (typeof signature !== 'string') return false
    const match = /^v2\.([a-zA-Z0-9_-]{1,40})\.([0-9a-f]{64})$/.exec(signature)
    if (match) {
      const keys = configuredKeys(env), [, keyId, digest] = match
      return Object.hasOwn(keys, keyId) && await verifyPythonSnapshot(jobId, { keyId, request }, digest, keys[keyId])
    }
    const legacy = JSON.parse(env.V4_SNAPSHOT_LEGACY_KEYS || '[]')
    if (!Array.isArray(legacy) || legacy.length > 8 || legacy.some(key => typeof key !== 'string' || key.length < 32)) return false
    for (const key of legacy) if (await verifyPythonSnapshot(jobId, request, signature, key)) return true
    return false
  } catch { return false }
}

async function snapshotKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Python snapshot signing requires a secret of at least 32 characters')
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function snapshotPayload(jobId: string, request: unknown): Uint8Array {
  if (!jobId || request === undefined) throw new Error('Python snapshot requires job ID and request')
  return encoder.encode(domain + JSON.stringify({ jobId, request }))
}

export async function signPythonSnapshot(jobId: string, request: unknown, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await snapshotKey(secret), snapshotPayload(jobId, request))
  return Array.from(new Uint8Array(signature), value => value.toString(16).padStart(2, '0')).join('')
}

export async function verifyPythonSnapshot(jobId: string, request: unknown, signature: string, secret: string): Promise<boolean> {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false
  try {
    const bytes = Uint8Array.from(signature.match(/../g)!, value => parseInt(value, 16))
    return await crypto.subtle.verify('HMAC', await snapshotKey(secret), bytes, snapshotPayload(jobId, request))
  } catch {
    return false
  }
}
