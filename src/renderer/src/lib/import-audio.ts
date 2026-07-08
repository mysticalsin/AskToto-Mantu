/**
 * Import-audio decode/chunk helpers. Decoding any target format (wav/mp3/m4a/aac/ogg/flac) and
 * resampling/mixing it down to 16kHz mono only works in the renderer — Chromium's AudioContext handles
 * every format main would otherwise need ffmpeg for (see src/main/import-audio.ts). chunkAudio is plain
 * array math and is unit-tested directly; decodeAndResampleToMono16k depends on the DOM's
 * OfflineAudioContext, so there's nothing meaningful to fake for it in a Node test.
 *
 * Typed arrays are explicitly parameterized `<ArrayBuffer>` throughout this file (rather than the bare
 * `Float32Array`, which defaults to the broader `ArrayBufferLike` under this project's combined
 * DOM + WebWorker lib config) so the chunks handed to window.toto.importAudioTranscribe line up with
 * ImportAudioChunk's samples field (main never receives a SharedArrayBuffer-backed view here anyway).
 */

export const IMPORT_CHUNK_SEC = 30
export const IMPORT_SAMPLE_RATE = 16000

// Safety cap on the DECODED PCM (post-decodeAudioData, pre-downmix — the largest single allocation in
// this pipeline). The 500 MB cap in main/import-audio.ts only bounds the COMPRESSED source file; with an
// unbounded compression ratio a long, highly-compressed recording can still decode to gigabytes of raw
// Float32 PCM and OOM the renderer's main thread. ~1.5 GB gives real meeting recordings (typically well
// under 2h) generous headroom while still failing safely — with a clear, catchable error instead of a
// crash — on pathological inputs.
const MAX_DECODED_BYTES = 1.5 * 1024 * 1024 * 1024

/**
 * Decode + resample to mono 16kHz. `decodeAudioData` resamples to its OWN context's sample rate as
 * part of decoding, so constructing the first OfflineAudioContext at 16000 does the resample for free —
 * only the channel mixdown still needs a render pass: playing the (possibly multi-channel) decoded
 * buffer into a 1-channel OfflineAudioContext downmixes it via the standard Web Audio channel-mixing
 * rules on connect.
 */
export async function decodeAndResampleToMono16k(arrayBuffer: ArrayBuffer): Promise<Float32Array<ArrayBuffer>> {
  const decodeCtx = new OfflineAudioContext(1, 1, IMPORT_SAMPLE_RATE)
  const decoded = await decodeCtx.decodeAudioData(arrayBuffer)
  const decodedBytes = decoded.length * decoded.numberOfChannels * Float32Array.BYTES_PER_ELEMENT
  if (decodedBytes > MAX_DECODED_BYTES) {
    throw new Error('That recording is too long to import safely. Choose a shorter recording.')
  }
  const mixCtx = new OfflineAudioContext(1, Math.max(1, decoded.length), IMPORT_SAMPLE_RATE)
  const src = mixCtx.createBufferSource()
  src.buffer = decoded
  src.connect(mixCtx.destination)
  src.start(0)
  const rendered = await mixCtx.startRendering()
  // No defensive .slice() here: chunkAudio below now copies each ~30s window with its own slice(), so
  // nothing downstream holds a view chained to this AudioBuffer's internal storage — an extra full-file
  // copy here would just be one more redundant peak-memory allocation.
  return rendered.getChannelData(0)
}

/**
 * Split mono samples into fixed-size ~30s windows (the last one shorter). Always returns at least one
 * chunk, even for empty audio (a zero-length one), so a session always gets exactly one done:true call.
 *
 * Uses `slice()` (a copy with its OWN backing ArrayBuffer), never `subarray()` (a view sharing the
 * source's ArrayBuffer). Each chunk crosses an Electron IPC boundary via `importAudioTranscribe`, and
 * structured-clone serializes a TypedArray's ENTIRE backing buffer, not just the view's range — a
 * subarray view would re-serialize the whole multi-hundred-MB decoded recording on every one of the
 * ~240 chunk calls a long import makes. slice() bounds each IPC payload to one ~30s window.
 */
export function chunkAudio(
  samples: Float32Array<ArrayBuffer>,
  chunkSec: number = IMPORT_CHUNK_SEC,
  sampleRate: number = IMPORT_SAMPLE_RATE
): Float32Array<ArrayBuffer>[] {
  const chunkLen = Math.max(1, Math.round(chunkSec * sampleRate))
  if (samples.length === 0) return [new Float32Array(0)]
  const chunks: Float32Array<ArrayBuffer>[] = []
  for (let i = 0; i < samples.length; i += chunkLen) {
    chunks.push(samples.slice(i, Math.min(i + chunkLen, samples.length)))
  }
  return chunks
}
