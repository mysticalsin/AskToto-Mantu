/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers'
import { shouldUseBundledAsr } from './asr-offline'

// Model source + offline behavior.
// Configured per-init based on whether bundled resources are present (reported by the main process).
// bundled=true:  use the asr-model:// Electron protocol for weights + ORT WASM (zero network).
//                transformers.js pathJoin('asr-model://models', repoId, file) preserves the `://`
//                because pathJoin only strips a leading `/` from non-first parts — the `//` in the
//                scheme authority is never touched. Verified against transformers.js@3.x source.
// bundled=false: use transformers.js defaults — remote HF hub + cdn.jsdelivr.net WASM (proven path).
//                This is the safe fallback for dev builds without running fetch-models.
// A production worker starts fail-closed even before its first init message. Development can still use
// the explicit remote fallback when the main process reports that local assets were not provisioned.
env.allowRemoteModels = import.meta.env.DEV
// env.allowLocalModels, env.localModelPath, and env.useBrowserCache are set conditionally inside the
// 'init' handler, based on whether bundled resources are present — see the bundled/else branches below.
const MODEL_REVISION = 'main' // pin to a specific commit SHA in production to resist upstream drift/tampering

// Engine tiers, best→fallback. WebGPU runs the large multilingual model at ~real-time on most machines;
// WASM is the universal fallback (no GPU / low RAM / older Electron) on a smaller model so it stays live.
// large-v3-turbo = ~99 languages with auto-detect ("whatever language is spoken"), near-large-v3 accuracy.
const WEBGPU_MODEL = 'onnx-community/whisper-large-v3-turbo'
const WASM_MODEL = 'Xenova/whisper-base' // multilingual, q8, comfortably real-time on CPU/WASM

/* eslint-disable @typescript-eslint/no-explicit-any */
let asr: any = null
let loading = false
let engine: 'webgpu' | 'wasm' | null = null
const post = (m: unknown): void => (self as unknown as Worker).postMessage(m)

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (self.navigator as any)?.gpu
    if (!gpu) return false
    const adapter = await gpu.requestAdapter()
    return !!adapter
  } catch {
    return false
  }
}

// Development-only remote model progress. Packaged builds load local files and do not download models.
function makeProgress(): (p: any) => void {
  let lastPct = -1
  return (p: any): void => {
    if (p?.status === 'progress' && p.total) {
      const pct = Math.round((p.loaded / p.total) * 100)
      if (pct !== lastPct) {
        lastPct = pct
        post({ type: 'progress', pct, file: p.file })
      }
    }
  }
}

async function load(quality: 'best' | 'fast', allowWebGpu: boolean): Promise<void> {
  // 'best' prefers WebGPU + the large multilingual model; 'fast' (and any fallback) uses the smaller model
  // so transcription always comes up (a degraded engine beats none) and compute stays light.
  const progress_callback = makeProgress()
  if (allowWebGpu && quality !== 'fast' && (await hasWebGPU())) {
    try {
      asr = await pipeline('automatic-speech-recognition', WEBGPU_MODEL, {
        device: 'webgpu',
        dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' },
        revision: MODEL_REVISION,
        progress_callback
      })
      engine = 'webgpu'
      return
    } catch (err) {
      post({ type: 'log', message: `webgpu load failed, falling back to wasm: ${String((err as Error)?.message || err)}` })
      asr = null
    }
  }
  asr = await pipeline('automatic-speech-recognition', WASM_MODEL, {
    dtype: 'q8',
    revision: MODEL_REVISION,
    progress_callback
  })
  engine = 'wasm'
}

self.onmessage = async (e: MessageEvent): Promise<void> => {
  const msg = e.data as { type: string; quality?: 'best' | 'fast'; audio?: Float32Array; speaker?: string; bundled?: boolean }

  if (msg.type === 'init') {
    if (asr || loading) return
    loading = true
    const bundled = shouldUseBundledAsr(import.meta.env.PROD, msg.bundled)
    // Configure the model source based on whether bundled resources are present.
    // Must run before load() so the pipeline() call picks up the correct paths.
    if (bundled) {
      env.allowLocalModels = true
      env.localModelPath = 'asr-model://models'
      // Zero-download guarantee: forbid any fallback fetch to the HF CDN when a bundled model file is
      // missing. Without this, transformers.js silently fetches the missing file from the network,
      // violating the "fully offline" contract. Fail visibly instead so missing files are caught early.
      env.allowRemoteModels = false
      // env.backends.onnx.wasm is typed as potentially undefined; guard before writing.
      // Overrides the cdn.jsdelivr.net default so WASM blobs load from bundled resources/ort/.
      if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = 'asr-model://ort/'
      // The bundled path serves every file instantly from local disk through the custom asr-model://
      // protocol, so persisting it in the browser's Cache Storage API buys nothing — and Chromium's
      // CacheStorage only recognizes http(s) requests, so transformers.js's getModelFile() cache lookup
      // (cache.match against the asr-model:// URL, tried before the real fetch) is rejected outright on
      // every single load ("Request scheme 'asr-model' is unsupported" console spam, on top of the
      // "Unable to load from local path" warning transformers.js logs once it falls through to the real
      // fetch). Disabling the browser cache for this path removes that dead, noisy lookup entirely.
      env.useBrowserCache = false
    } else {
      env.allowLocalModels = false // remote models + transformers.js default CDN wasm (proven path)
      env.allowRemoteModels = true // this branch is reachable only in development (see bundled above)
      // Remote (dev-only) models are fetched from the real HF CDN over https, where the browser cache is
      // both supported and worth having — it saves re-downloading ~150MB of weights on every worker restart.
      env.useBrowserCache = true
    }
    try {
      // Standard installers deliberately ship the compact WASM fallback, not the 1.5 GiB WebGPU
      // model. Avoid a guaranteed missing-model attempt in that offline configuration.
      const requestedQuality = msg.quality === 'fast' ? 'fast' : 'best'
      await load(requestedQuality, !bundled)
      // Report honestly whenever 'best' was requested but didn't actually land on the WebGPU/large model
      // (no bundled model, no WebGPU adapter, or a WebGPU load failure) — callers must not infer quality
      // from the request alone, since it silently downgrades to WASM/whisper-base in every packaged build.
      post({ type: 'ready', engine, requestedQuality, qualityDegraded: requestedQuality === 'best' && engine !== 'webgpu' })
    } catch (err) {
      // Both paths failed. The raw transformers.js message ("local_files_only=true … file was not found
      // locally at asr-model://…") is meaningless to a user mid-meeting — surface a human line instead,
      // and keep the raw detail in a log post for diagnostics.
      post({ type: 'log', message: `ASR load failed: ${String((err as Error)?.message || err)}` })
      post({
        type: 'error',
        message: bundled
          ? 'The bundled transcription files are missing or damaged. Reinstall Métis from a complete installer.'
          : 'Could not load the transcription model. Check your internet connection and try Listen again.'
      })
    } finally {
      loading = false
    }
    return
  }

  if (msg.type === 'audio') {
    const speaker = msg.speaker
    // Always emit exactly one terminal reply so the renderer queue never wedges.
    if (!asr || !msg.audio) {
      post({ type: 'text', text: '', speaker })
      return
    }
    try {
      // No `language` set → Whisper auto-detects the spoken language per window (keeps full multilingual
      // coverage). Live windows are short (≤6s, VAD-endpointed) and always fit Whisper's native 30s context,
      // so we decode the whole clip in ONE pass: no `chunk_length_s` stitching and `return_timestamps:false`
      // so the decoder never spends generation steps emitting <|t|> timestamp tokens we don't use. Both cut
      // per-window decode latency with zero accuracy cost — chunking only ever mattered for long files we
      // never produce here.
      const out: any = await asr(msg.audio, { return_timestamps: false })
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out?.text || '').trim()
      post({ type: 'text', text, speaker })
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err), speaker })
    }
  }
}
