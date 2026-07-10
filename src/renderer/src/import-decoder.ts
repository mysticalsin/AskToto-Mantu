import { IMPORT_CHUNK_SEC, IMPORT_SAMPLE_RATE, decodeAndResampleToMono16k } from './lib/import-audio'

type Start = { jobId: string; skipThrough: number }
type SourceChunk = { jobId: string; bytes: Uint8Array; done: boolean }

interface ImportDecoderApi {
  ready(): void
  onStart(callback: (payload: Start) => void): () => void
  onSourceChunk(callback: (payload: SourceChunk) => void): () => void
  acknowledgeSource(jobId: string): void
  submitChunk(payload: { jobId: string; seq: number; totalChunks: number; samples: Float32Array }): Promise<void>
  complete(jobId: string): Promise<void>
  fail(jobId: string, error: string): Promise<void>
}

declare global {
  interface Window {
    importDecoder: ImportDecoderApi
  }
}

let start: Start | null = null
let parts: Uint8Array[] = []
let byteLength = 0
let decoding = false

function copyChunk(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

async function decode(): Promise<void> {
  if (!start || decoding) return
  decoding = true
  const active = start
  try {
    const source = new Uint8Array(byteLength)
    let offset = 0
    for (const part of parts) {
      source.set(part, offset)
      offset += part.byteLength
    }
    // Release transport buffers before Chromium creates its decoded PCM buffer.
    parts = []
    byteLength = 0
    const samples = await decodeAndResampleToMono16k(source.buffer)
    const chunkLength = Math.max(1, Math.round(IMPORT_CHUNK_SEC * IMPORT_SAMPLE_RATE))
    const totalChunks = Math.max(1, Math.ceil(samples.length / chunkLength))
    for (let seq = active.skipThrough; seq < totalChunks; seq++) {
      const start = seq * chunkLength
      await window.importDecoder.submitChunk({
        jobId: active.jobId,
        seq,
        totalChunks,
        // Own only the one IPC window in flight. Keeping `chunkAudio(samples)` here would allocate a
        // second full-recording worth of PCM before main has transcribed the first window.
        samples: samples.slice(start, Math.min(start + chunkLength, samples.length))
      })
    }
    await window.importDecoder.complete(active.jobId)
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    // ImportDecoderFailedSchema (src/shared/ipc.ts) requires a 1-800 char string; an empty or oversized
    // message fails validation and leaves the job stuck non-terminal, blocking the whole FIFO queue.
    await window.importDecoder.fail(active.jobId, (raw || 'Unknown decoder error').slice(0, 800))
  } finally {
    decoding = false
  }
}

window.importDecoder.onStart((payload) => {
  start = payload
  parts = []
  byteLength = 0
})

window.importDecoder.onSourceChunk((payload) => {
  if (!start || payload.jobId !== start.jobId) return
  if (payload.bytes.byteLength) {
    const part = copyChunk(payload.bytes)
    parts.push(part)
    byteLength += part.byteLength
  }
  // Back-pressure: main sends the next source segment only after this acknowledgement, so a large file
  // cannot pile up hundreds of IPC payloads in memory.
  window.importDecoder.acknowledgeSource(payload.jobId)
  if (payload.done) void decode()
})

// Main waits for this handshake before sending any source bytes. Without it a fast local file could
// arrive between did-finish-load and the module registering its IPC listeners.
window.importDecoder.ready()
