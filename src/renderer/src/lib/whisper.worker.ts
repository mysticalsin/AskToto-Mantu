/// <reference lib="webworker" />
import { pipeline, env } from '@huggingface/transformers'
import { shouldUseBundledAsr } from './asr-offline'
import { detectLanguage, LANGUAGE_NAMES } from '@shared/lang-id'

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

// ── Language follow ─────────────────────────────────────────────────────────────────────────────
// The user's spoken-language setting seeds which language we DECODE in, but meetings switch languages
// mid-conversation (Portuguese call, English segment, back). A hard pin would transcribe the English
// segment as Portuguese-shaped garbage; pure per-window auto-detect is exactly what made the compact
// model hallucinate in the first place. So: adaptive pin with an escape hatch.
//
//   - activeLang: the language windows are currently decoded in (null = per-window auto-detect).
//     Seeded from the init message's language ('auto' → null), applied per decode call, NOT at model
//     load — a warm worker picks up a changed setting from the next init without reloading weights.
//   - Probe: every PROBE_EVERY-th window decodes WITHOUT the pin, so a real mid-meeting language
//     switch produces natural text in the new language at most ~3 windows (≈18s) late. Probing is how
//     switches get noticed at all: a pinned decode of switched speech yields pinned-language-shaped
//     text that language-ID can't flag.
//   - Follow: text-side language ID (shared/lang-id.ts, deliberately conservative — null on doubt)
//     runs on every decoded window while still un-pinned. SWITCH_AFTER consecutive confident detections
//     of the same OTHER language re-pin activeLang; while a switch is suspected (switchRun set) every
//     window decodes un-pinned so confirmation doesn't wait for the next probe. In 'auto' mode the same
//     machinery CONVERGES onto the conversation's language, giving pin-quality decoding without a setting.
//
// PROVEN FACT (2026-08-05, direct probe): transformers.js's whisper NEVER auto-detects on an un-pinned
// call — it logs "No language specified - defaulting to English" and decodes ENGLISH regardless of what
// was actually spoken. Two consequences, fixed here the same way whisper-import.ts's ported copy of this
// machinery was fixed first: (1) an explicit user language must decode EVERY window pinned — the old
// "probe every 4th window un-pinned" escape hatch just fed English junk into followLanguage() and could
// mis-switch a correctly-pinned session; (2) once a language is known from ANY source — an explicit
// setting, or an external 'pinLanguage' message (see below) — this worker never decodes un-pinned again.
// Only the probe-less 'auto' path (no external pin yet) still runs the old un-pinned converge/follow
// machinery as a fallback, exactly as before.
//
// External pin (renderer main thread, listen.ts): Whisper itself cannot tell what language a clip is
// without decoding it in every candidate language, but Parakeet takes no `language` option — its output
// is a steadier signal. listen.ts feeds early/periodic windows to window.toto.parakeetFeed() alongside the
// whisper decode (fire-and-forget, never blocking) and posts { type: 'pinLanguage', language } once
// shared/lang-id.ts confidently identifies the audio. Mirrors whisper-import.ts's probeLanguage /
// reprobeForSwitch pair, just driven from the renderer instead of from inside this worker (a Web Worker
// has no IPC access to call Parakeet itself).
//
// Every LANGUAGE_NAMES entry lowercased is a valid Whisper language token (lang-id.ts's contract).
// Unknown init values (stale/managed garbage) safely mean 'auto' instead of throwing mid-meeting.
const PROBE_EVERY = 4
const SWITCH_AFTER = 2
// A suspected switch gets this many windows (from first suspicion) to confirm; then it's abandoned and
// decoding returns to the pin, with the periodic probe still watching. Bounds two failure modes: a
// single null/ambiguous detection can no longer cancel a genuine switch mid-confirmation, and noisy
// alternating detections (Spanish, German, Spanish…) can no longer hold the decoder un-pinned forever.
// TUNING INVARIANTS (from the adversarial re-review's window-by-window trace): keep
// PROBE_PATIENCE % PROBE_EVERY === 0 — a run always starts on a probe-aligned window, so this is what
// makes an abandoned-but-genuine switch get re-caught by the VERY NEXT window (itself a probe) with
// zero wasted pinned windows — and keep SWITCH_AFTER <= PROBE_PATIENCE or confirmation becomes
// permanently unreachable (every run would age out before reaching the required count).
const PROBE_PATIENCE = 4
let userLanguage = 'auto'
let activeLang: string | null = null
let switchRun: { lang: string; count: number; age: number } | null = null
let windowCount = 0
// True once an external 'pinLanguage' message (see self.onmessage below) has confirmed the language —
// from that point on this worker never decodes un-pinned again, for the rest of the session (see
// nextDecodeOptions-equivalent logic in the audio handler below and followLanguage's guard).
let probePinned = false

/** Hard reset of the follow machine, re-seeded from the given setting value. */
function resetLanguageFollow(next: string): void {
  userLanguage = next
  activeLang = (LANGUAGE_NAMES as readonly string[]).includes(next) ? next : null
  switchRun = null
  windowCount = 0
  probePinned = false
}

/** Delta update (mid-session setLanguage): only a CHANGED value re-seeds, so an unchanged setting
 *  leaves an in-progress follow (converged pin, suspected switch) untouched. Session starts must use
 *  the init message's `resetFollow` flag instead — module state survives on a warm worker, and without
 *  the hard reset a new meeting would inherit the previous meeting's converged language (the
 *  cross-session leak the 4-agent review demonstrated). */
function applyInitLanguage(next: string): void {
  if (next === userLanguage) return
  resetLanguageFollow(next)
}

function followLanguage(text: string): void {
  // Text-side following only ever steers the probe-less 'auto' path: an explicit user language must
  // never be second-guessed from decoded text, and once an external 'pinLanguage' message owns the pin
  // every window is pinned-language-shaped by construction — text signals from either state can only be
  // false (see whisper-import.ts's followLanguage, which carries the identical guard).
  if (userLanguage !== 'auto' || probePinned) return
  const detected = detectLanguage(text).lang
  if (switchRun) {
    switchRun.age += 1
    if (detected && detected === switchRun.lang) {
      switchRun.count += 1
      if (switchRun.count >= SWITCH_AFTER) {
        post({ type: 'log', message: `language follow: ${activeLang ?? 'auto'} → ${detected}` })
        activeLang = detected
        switchRun = null
        return
      }
    } else if (detected && detected === activeLang) {
      switchRun = null // the current pin re-confirmed — false alarm, back to pinned decoding
      return
    } else if (detected) {
      // Different candidate than the one being confirmed: restart the count but keep the age budget —
      // unstable detections must run the budget down, not extend it.
      switchRun = { lang: detected, count: 1, age: switchRun.age }
    }
    // Null detections keep the run alive (a short utterance mid-switch must not cancel confirmation)
    // but still consume budget via the age increment above.
    if (switchRun && switchRun.age >= PROBE_PATIENCE) switchRun = null
    return
  }
  if (!detected || detected === activeLang) return
  switchRun = { lang: detected, count: 1, age: 1 }
  // In 'auto' mode (activeLang null) this same run is the convergence path: SWITCH_AFTER confident
  // detections of the conversation's language turn auto-decode into a quality-stabilizing pin.
}

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
  const msg = e.data as {
    type: string
    quality?: 'best' | 'fast'
    audio?: Float32Array
    speaker?: string
    bundled?: boolean
    language?: string
    resetFollow?: boolean
    partial?: boolean
  }

  if (msg.type === 'init') {
    // Update the language BEFORE the already-loaded early return: a warm (prewarmed or reused) worker
    // must still honor the session's language even though it skips the model load below. Session starts
    // set resetFollow so a NEW meeting never inherits the previous meeting's converged follow state
    // (the same 'auto' value would otherwise no-op the delta path and leak activeLang across sessions);
    // mid-session re-inits (setLanguage, engine fallback, network retry) omit it and take the delta path.
    if (msg.resetFollow) resetLanguageFollow(typeof msg.language === 'string' && msg.language ? msg.language : 'auto')
    else if (typeof msg.language === 'string' && msg.language) applyInitLanguage(msg.language)
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

  if (msg.type === 'pinLanguage') {
    // External confirmation from listen.ts's main-thread Parakeet probe (see the block comment above) —
    // only meaningful while still in 'auto' mode: an explicit user language is never second-guessed by a
    // probe, mirroring whisper-import.ts's probeLanguage guard. Once applied, probePinned latches true for
    // the rest of the session (resetLanguageFollow is the only way back to false) — a later switch is
    // communicated by another 'pinLanguage' message with the new language (first pin is not forever).
    if (
      userLanguage === 'auto' &&
      typeof msg.language === 'string' &&
      (LANGUAGE_NAMES as readonly string[]).includes(msg.language)
    ) {
      activeLang = msg.language
      probePinned = true
      switchRun = null
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
      // Decode language comes from the language-follow machine (see its block comment above): pinned to
      // activeLang (`language` + task 'transcribe', never 'translate') except on probe windows and while
      // a switch is being confirmed, which decode with per-window auto-detect. Live windows are short
      // (≤6s, VAD-endpointed) and always fit Whisper's native 30s context, so we decode the whole clip in
      // ONE pass: no `chunk_length_s` stitching and `return_timestamps:false` so the decoder never spends
      // generation steps emitting <|t|> timestamp tokens we don't use. Both cut per-window decode latency
      // with zero accuracy cost — chunking only ever mattered for long files we never produce here.
      // `probing` (un-pinned decode) is now reachable ONLY while still un-pinned AND in 'auto' mode —
      // once probePinned (an external 'pinLanguage' message) or an explicit user language applies,
      // transformers.js's real "always defaults to English on an un-pinned call" behavior (see the block
      // comment above) makes periodic un-pinned probing actively harmful, not just unnecessary.
      windowCount += 1
      const probing =
        !probePinned &&
        userLanguage === 'auto' &&
        (switchRun !== null || (activeLang !== null && windowCount % PROBE_EVERY === 0))
      const opts: { return_timestamps: boolean; language?: string; task?: string } = { return_timestamps: false }
      if (activeLang && !probing) {
        opts.language = activeLang.toLowerCase()
        opts.task = 'transcribe'
      }
      const out: any = await asr(msg.audio, opts)
      const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out?.text || '').trim()
      if (text) followLanguage(text)
      post({ type: 'text', text, speaker, partial: !!msg.partial })
    } catch (err) {
      // Same rule as the load-failure branch above, which this used to ignore: the engine's own text
      // ("Aborted(). Build with -sASSERTIONS for more info.", "memory access out of bounds") is a WASM
      // stack fragment, not something a user mid-meeting can act on — and it landed in the live danger
      // banner, which has no dismiss control. Raw detail goes to the log post; the user gets one fixed
      // line, which listen.ts retracts by exact match on the next window that decodes. Deliberately NOT
      // silent (an empty text reply): a permanently dead WASM module would then produce an empty
      // transcript with no signal anywhere.
      post({ type: 'log', message: `ASR window failed: ${String((err as Error)?.message || err)}` })
      post({ type: 'error', message: 'Part of the audio could not be transcribed. Transcription is continuing.', speaker })
    }
  }
}
