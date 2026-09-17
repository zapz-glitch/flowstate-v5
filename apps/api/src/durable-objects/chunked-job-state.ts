// Leave ample room below the legacy Durable Object 128 KiB value limit.
const CHUNK_BYTES = 60 * 1024
const KEY = 'jobState'
interface Manifest { format: 'chunked-job-state-v1'; chunks: number; bytes: number }
function isManifest(value: unknown): value is Manifest {
  return !!value && typeof value === 'object' && 'format' in value && value.format === 'chunked-job-state-v1'
}
const chunkKey = (index: number) => `${KEY}:chunk:${index}`

/** Atomic snapshots retain every event, including individual oversized results. */
export class ChunkedJobState<T> {
  private pending: Promise<void> = Promise.resolve()
  constructor(private storage: DurableObjectStorage) {}

  async read(): Promise<T | null> {
    return this.storage.transaction(async tx => {
      const value = await tx.get<T | Manifest>(KEY)
      if (!isManifest(value)) return value ?? null
      if (!Number.isSafeInteger(value.chunks) || !Number.isSafeInteger(value.bytes) ||
          value.bytes <= 0 || value.chunks !== Math.ceil(value.bytes / CHUNK_BYTES)) {
        throw new Error('Invalid analysis state manifest')
      }
      const bytes = new Uint8Array(value.bytes)
      for (let index = 0; index < value.chunks; index++) {
        const chunk = await tx.get<Uint8Array>(chunkKey(index))
        const expected = Math.min(CHUNK_BYTES, value.bytes - index * CHUNK_BYTES)
        if (!(chunk instanceof Uint8Array) || chunk.byteLength !== expected) {
          throw new Error('Incomplete analysis state snapshot')
        }
        bytes.set(chunk, index * CHUNK_BYTES)
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as T
    })
  }

  write(value: T): Promise<void> {
    // Capture before yielding: callers may append another event concurrently.
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    const manifest: Manifest = { format: 'chunked-job-state-v1', chunks: Math.ceil(bytes.length / CHUNK_BYTES), bytes: bytes.length }
    const write = this.pending.then(() => this.storage.transaction(async tx => {
      const previous = await tx.get<T | Manifest>(KEY)
      for (let index = 0; index < manifest.chunks; index++) {
        await tx.put(chunkKey(index), bytes.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES))
      }
      if (isManifest(previous)) {
        for (let index = manifest.chunks; index < previous.chunks; index++) await tx.delete(chunkKey(index))
      }
      await tx.put(KEY, manifest)
    }))
    this.pending = write.catch(() => {})
    return write
  }
}
