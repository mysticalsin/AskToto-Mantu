/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers'

// Model source + offline behavior.
// Configured per-init based on whether bundled resources are present (reported by the main process).
// bundled=true:  use the asr-model:// Electron protocol for weights + ORT WASM (zero network).
//                transformers.js pathJoin('asr-model://models', repoId, file) preserves the `://`
//                because pathJoin only strips a leading `/` from non-first parts — the `//` in the
//                scheme authority is never touched. Verified against transformers.js@3.x source.
// bundled=false: use transformers.js defaults — remote HF hub + cdn.jsdelivr.net WASM (proven path).
//                This is the safe fallback for dev builds without running fetch-models.
env.allowRemoteModels = true
env.useBrowserCache = true
// env.allowLocalModels and env.localModelPath are set conditionally inside the 'init' handler.
// Snapshot the library's default WASM location before bundled mode overwrites it, so a bundled-load
// failure can restore it for the remote retry below.
const DEFAULT_WASM_PATHS = env.backends?.onnx?.wasm?.wasmPaths
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

// Report model-download progress to the UI so a ~800MB first-run fetch doesn't look frozen. The callback
// fires per file; we surface the largest in-flight file's percentage (the dominant wait).
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
  // so transcription always comes up (a degraded engine beats none) and the download/compute stays light.
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
    // Configure the model source based on whether bundled resources are present.
    // Must run before load() so the pipeline() call picks up the correct paths.
    if (msg.bundled) {
      env.allowLocalModels = true
      env.localModelPath = 'asr-model://models'
      // Zero-download guarantee: forbid any fallback fetch to the HF CDN when a bundled model file is
      // missing. Without this, transformers.js silently fetches the missing file from the network,
      // violating the "fully offline" contract. Fail visibly instead so missing files are caught early.
      env.allowRemoteModels = false
      // env.backends.onnx.wasm is typed as potentially undefined; guard before writing.
      // Overrides the cdn.jsdelivr.net default so WASM blobs load from bundled resources/ort/.
      if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = 'asr-model://ort/'
    } else {
      env.allowLocalModels = false // remote models + transformers.js default CDN wasm (proven path)
      // allowRemoteModels stays true (set at module level) — this is the normal dev/remote path.
    }
    try {
      // Standard installers deliberately ship the compact WASM fallback, not the 1.5 GiB WebGPU
      // model. Avoid a guaranteed missing-model attempt in that offline configuration.
      const requestedQuality = msg.quality === 'fast' ? 'fast' : 'best'
      try {
        await load(requestedQuality, !msg.bundled)
      } catch (err) {
        // Bundled (offline) load failed — a file the ASR_BUNDLED manifest check couldn't catch is missing
        // or unreadable through asr-model://. Rather than bricking Listen for the whole session
        // (allowRemoteModels=false makes this a hard failure), retry ONCE on the proven remote path.
        if (!msg.bundled) throw err
        post({ type: 'log', message: `bundled ASR load failed, retrying remote: ${String((err as Error)?.message || err)}` })
        env.allowLocalModels = false
        env.allowRemoteModels = true
        if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = DEFAULT_WASM_PATHS
        await load(requestedQuality, false)
      }
      // Report honestly whenever 'best' was requested but didn't actually land on the WebGPU/large model
      // (no bundled model, no WebGPU adapter, or a WebGPU load failure) — callers must not infer quality
      // from the request alone, since it silently downgrades to WASM/whisper-base in every packaged build.
      post({ type: 'ready', engine, requestedQuality, qualityDegraded: requestedQuality === 'best' && engine !== 'webgpu' })
    } catch (err) {
      // Both paths failed. The raw transformers.js message ("local_files_only=true … file was not found
      // locally at asr-model://…") is meaningless to a user mid-meeting — surface a human line instead,
      // and keep the raw detail in a log post for diagnostics.
      post({ type: 'log', message: `ASR load failed: ${String((err as Error)?.message || err)}` })
      post({ type: 'error', message: 'Could not load the transcription model. Check your internet connection and try Listen again.' })
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
