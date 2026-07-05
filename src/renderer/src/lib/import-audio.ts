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
  const mixCtx = new OfflineAudioContext(1, Math.max(1, decoded.length), IMPORT_SAMPLE_RATE)
  const src = mixCtx.createBufferSource()
  src.buffer = decoded
  src.connect(mixCtx.destination)
  src.start(0)
  const rendered = await mixCtx.startRendering()
  return rendered.getChannelData(0).slice()
}

/**
 * Split mono samples into fixed-size ~30s windows (the last one shorter). Always returns at least one
 * chunk, even for empty audio (a zero-length one), so a session always gets exactly one done:true call.
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
    chunks.push(samples.subarray(i, Math.min(i + chunkLen, samples.length)))
  }
  return chunks
}
