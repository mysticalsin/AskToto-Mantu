/**
 * whisper-asr-host.ts — the utilityProcess child that owns the @huggingface/transformers stack.
 *
 * MQA-234: sherpa-onnx-node and onnxruntime-node both ship an `onnxruntime` DLL under the same name.
 * On Windows, whichever loads SECOND into a process is broken — transformers-after-sherpa dies at
 * require() with ERR_DLOPEN_FAILED, and sherpa-after-transformers loads but crashes the whole app
 * natively on its first decode (both directions proven in the packaged main process; the load-order
 * "fix" was shipped and reverted the same day when the packaged-ASR gate caught the crash). The only
 * correct shape is process isolation: THIS child requires transformers/onnxruntime-node and never
 * touches sherpa; the main process keeps sherpa (Parakeet, speaker-id) and never requires transformers.
 *
 * Protocol (over process.parentPort):
 *   in : { type: 'init', modelsPath: string }                       — where the bundled models live
 *   in : { type: 'transcribe', id: number, pcm: ArrayBuffer,        — one 16kHz mono f32 window
 *          language?: string, task?: string }
 *   out: { type: 'ready' } | { type: 'result', id, text } | { type: 'error', id?, message }
 *
 * The model pipeline loads lazily on the first transcribe and is memoized; a load failure is reported
 * per-request so the parent's existing Parakeet fallback (index.ts's import `transcribe` seam) keeps
 * its "an engine choice must never fail an import" guarantee.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Model tiers, best-first. large-v3-turbo is the near-Plaud-quality tier (benchmarked on this class of
// hardware at ~1.5x realtime CPU — a VAD-trimmed 31-min meeting decodes in ~15 min) but its ~1.6GB of
// weights only exist where the WebGPU ASR tier was provisioned (fetch-models.mjs, ASKTOTO_INCLUDE_WEBGPU_ASR
// or a later in-app download). whisper-base is the always-bundled floor. The host picks the best tier whose
// files are actually on disk — availability, not configuration, decides.
const MODEL_TIERS = [
  {
    id: 'onnx-community/whisper-large-v3-turbo',
    // The exact dtype pair benchmarked: fp16 encoder + q4 merged decoder — what the provisioned files are.
    dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' } as const
  },
  { id: 'Xenova/whisper-base', dtype: 'q8' as const }
]
const MODEL_REVISION = 'main'

let modelsPath: string | null = null
let transformersModule: any = undefined // undefined = unprobed, null = probed and failed
let asr: any = null
let loadingAsr: Promise<any> | null = null

function loadTransformers(): any | null {
  if (transformersModule !== undefined) return transformersModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    transformersModule = require('@huggingface/transformers')
  } catch (e) {
    transformersModule = null
    // Surfaced per-request below; also to stderr so the parent's utilityProcess stdio capture sees it.
    console.error('[whisper-asr-host] transformers failed to load:', (e as Error)?.message || String(e))
  }
  return transformersModule
}

async function ensureAsr(): Promise<any> {
  if (asr) return asr
  if (loadingAsr) return loadingAsr
  const mod = loadTransformers()
  if (!mod || !modelsPath) throw new Error('The bundled transcription files are missing or damaged. Reinstall Métis from a complete installer.')
  const { pipeline, env } = mod
  env.allowLocalModels = true
  env.localModelPath = modelsPath
  env.allowRemoteModels = false // offline-only, same guarantee as the renderer's bundled worker
  env.useBrowserCache = false
  const tier = MODEL_TIERS.find((t) => existsSync(join(modelsPath as string, t.id))) ?? MODEL_TIERS[MODEL_TIERS.length - 1]
  console.error(`[whisper-asr-host] loading ${tier.id}`)
  loadingAsr = pipeline('automatic-speech-recognition', tier.id, { dtype: tier.dtype, revision: MODEL_REVISION })
    .then((p: any) => {
      asr = p
      return p
    })
    .catch((e: unknown) => {
      // Mirrors parakeet.ts's/the pre-MQA-234 whisper-import.ts reinstall-guidance pattern: a caller (the
      // renderer's error toast) needs an actionable message, not transformers.js's internal
      // `local_files_only` wording. The raw reason still reaches the packaged app's log via stderr (the
      // parent pipes this to mainLog.warn — see whisper-import.ts's ensureHost).
      console.error('[whisper-asr-host] model load failed:', e instanceof Error ? e.message : String(e))
      throw new Error('The bundled transcription files are missing or damaged. Reinstall Métis from a complete installer.')
    })
    .finally(() => {
      loadingAsr = null
    })
  return loadingAsr
}

async function transcribe(pcm: ArrayBuffer, language?: string, task?: string): Promise<string> {
  const model = await ensureAsr()
  const samples = new Float32Array(pcm)
  const opts: Record<string, unknown> = { return_timestamps: false }
  if (language) opts.language = language
  if (task) opts.task = task
  const out: any = await model(samples, opts)
  return Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text || ''
}

// process.parentPort only exists inside an Electron utilityProcess — everywhere else (a stray node
// invocation, a test import) this module must be inert rather than crash.
const port: any = (process as any).parentPort
if (port) {
  port.on('message', (event: any) => {
    const msg = event?.data ?? event
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'init') {
      modelsPath = typeof msg.modelsPath === 'string' ? msg.modelsPath : null
      port.postMessage({ type: 'ready' })
      return
    }
    if (msg.type === 'transcribe') {
      const { id, pcm, language, task } = msg
      transcribe(pcm, language, task)
        .then((text) => port.postMessage({ type: 'result', id, text }))
        .catch((e: unknown) =>
          port.postMessage({ type: 'error', id, message: e instanceof Error ? e.message : String(e) })
        )
    }
  })
  port.start?.()
}
