/**
 * Main-process Whisper transcriber for background import jobs (import-jobs.ts's serialized, one-at-a-time
 * pump). Imported recordings deserve the same multilingual quality live Listen gets: this loads the exact
 * bundled whisper-base model files the renderer's Listen worker uses (resources/models/Xenova/whisper-base
 * — see asr-manifest.ts) and ports that worker's adaptive language-follow machine (renderer/src/lib/
 * whisper.worker.ts, PR #29) near-verbatim, so an imported FR/EN meeting gets the same mid-recording
 * language switching a live meeting does, instead of one language baked in for the whole file.
 *
 * Runs in Node, not a browser worker, so there is no asr-model:// protocol here and none is needed:
 * transformers.js's Node backend resolves env.localModelPath with plain fs reads whenever RUNNING_LOCALLY
 * is true (see @huggingface/transformers/src/env.js) — pointing it at the SAME models/ directory the
 * protocol handler serves from is enough.
 *
 * @huggingface/transformers is loaded via a lazy, memoized require() — never a static top-level import —
 * so the packaged bytecode main (electron.vite.config.ts's build.bytecode) never eagerly pulls in its
 * onnxruntime-node/sharp native dependencies just because this module got loaded; the load is deferred to
 * the first actual import job. Mirrors parakeet.ts's probeSherpa() memo for the exact same reason.
 */
import { app } from 'electron'
import { join } from 'node:path'
import { detectLanguage, LANGUAGE_NAMES } from '@shared/lang-id'
import { collapseRepeatedPhrase } from '@shared/transcript-filter'
import { mainLog } from './logger'

const MODEL_ID = 'Xenova/whisper-base' // same bundled multilingual model the renderer's WASM fallback uses
const MODEL_REVISION = 'main' // pin to a specific commit SHA in production to resist upstream drift/tampering

/** resources/models — the same directory asr-model://models is rooted at (see index.ts's protocol
 *  handler), read here directly off disk since main has no need for (and cannot use) that renderer-only
 *  custom protocol. */
function modelsDir(): string {
  const REPO_ROOT = join(__dirname, '..', '..')
  const base = app.isPackaged ? process.resourcesPath : join(REPO_ROOT, 'resources')
  return join(base, 'models')
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// undefined = not probed yet; null = probed and require() threw; otherwise the loaded module. require()
// itself does not cache a failed load, so without this memo a repeated probe would repeat the attempt.
let transformersModule: any = undefined

/** Probe (once, memoized forever — success or failure) whether @huggingface/transformers loads. Mirrors
 *  parakeet.ts's probeSherpa(). */
function loadTransformers(): any | null {
  if (transformersModule !== undefined) return transformersModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    transformersModule = require('@huggingface/transformers')
  } catch (e) {
    transformersModule = null
    mainLog.error('[whisper-import] @huggingface/transformers failed to load:', (e as Error)?.message || String(e))
  }
  return transformersModule
}

let asr: any = null
let loadingAsr: Promise<any> | null = null

/** Loads the pipeline once and memoizes it; concurrent callers await the same in-flight load. Imports are
 *  processed one at a time (ImportJobManager's FIFO pump), so this is never contended in practice, but the
 *  guard keeps a warm-vs-cold caller from racing two separate ~150MB model loads regardless. */
async function ensureAsr(): Promise<any> {
  if (asr) return asr
  if (loadingAsr) return loadingAsr
  const reinstallMessage = 'The bundled transcription files are missing or damaged. Reinstall Métis from a complete installer.'
  const mod = loadTransformers()
  if (!mod) throw new Error(reinstallMessage)
  const { pipeline, env } = mod
  env.allowLocalModels = true
  env.localModelPath = modelsDir()
  // Imports are offline-only, the same guarantee the renderer's bundled worker gives live Listen: never
  // fall back to a network fetch for a missing file.
  env.allowRemoteModels = false
  env.useBrowserCache = false
  loadingAsr = pipeline('automatic-speech-recognition', MODEL_ID, { dtype: 'q8', revision: MODEL_REVISION })
    .then((p: any) => {
      asr = p
      return p
    })
    .catch((e: unknown) => {
      // The raw transformers.js message ("local_files_only=true … file was not found locally at
      // …/models/Xenova/whisper-base/…") is meaningless to a user reading an import failure — log the
      // detail and surface the same human line the renderer's bundled-mode worker uses.
      mainLog.error('[whisper-import] model load failed:', (e as Error)?.message || String(e))
      throw new Error(reinstallMessage)
    })
    .finally(() => {
      loadingAsr = null
    })
  return loadingAsr
}

// ── Language follow (ported near-verbatim from renderer/src/lib/whisper.worker.ts, PR #29) ───────────────
// See that file's block comment for the full design rationale — the mechanics are identical here: an
// adaptive pin with a periodic un-pinned probe, and text-side language-ID (shared/lang-id.ts) confirming
// genuine mid-recording switches. Imports call transcribe() once per decoded chunk instead of once per
// live VAD window, but the same "meetings switch languages mid-conversation" problem applies — a hard pin
// on the whole file would transcribe a language switch as pinned-language-shaped garbage.
const PROBE_EVERY = 4
const SWITCH_AFTER = 2
const PROBE_PATIENCE = 4
let userLanguage = 'auto'
let activeLang: string | null = null
let switchRun: { lang: string; count: number; age: number } | null = null
let windowCount = 0

/** Hard reset of the follow machine, re-seeded from the given setting value. Call once per job, at decode
 *  start (see index.ts's initializeImportJobs) — module state survives across import jobs on the same
 *  running main process, and without this a new job would inherit the previous job's converged language. */
export function resetLanguageFollow(next: string): void {
  userLanguage = next
  activeLang = (LANGUAGE_NAMES as readonly string[]).includes(next) ? next : null
  switchRun = null
  windowCount = 0
}

/** Delta update: only a CHANGED value re-seeds, so re-reading the same setting on every chunk (the common
 *  case — nobody edits Settings mid-import) leaves an in-progress follow (converged pin, suspected switch)
 *  untouched. whisperImportTranscribe calls this on every chunk since imports have no separate "session
 *  init" message the way the live worker does; a job-start reset alone would not notice the user changing
 *  the language setting partway through a long import. */
export function applyInitLanguage(next: string): void {
  if (next === userLanguage) return
  resetLanguageFollow(next)
}

export function followLanguage(text: string): void {
  const detected = detectLanguage(text).lang
  if (switchRun) {
    switchRun.age += 1
    if (detected && detected === switchRun.lang) {
      switchRun.count += 1
      if (switchRun.count >= SWITCH_AFTER) {
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
  // detections of the recording's language turn auto-decode into a quality-stabilizing pin.
}

/** This window's decode options, and advances windowCount — the exact per-window decision from
 *  whisper.worker.ts's audio handler. A standalone export (rather than inlined into
 *  whisperImportTranscribe below) so the follow machine is testable without a loaded model. */
export function nextDecodeOptions(): { return_timestamps: boolean; language?: string; task?: string } {
  windowCount += 1
  const probing = switchRun !== null || (activeLang !== null && windowCount % PROBE_EVERY === 0)
  const opts: { return_timestamps: boolean; language?: string; task?: string } = { return_timestamps: false }
  if (activeLang && !probing) {
    opts.language = activeLang.toLowerCase()
    opts.task = 'transcribe'
  }
  return opts
}

// ── Initial-pin probe (whisper-base's per-window audio auto-detect is unreliable, esp. on a compact
// model decoding a 12s import slab with no VAD trim — see whisper-import.test.ts's probe suite for the
// exact field failure) ──────────────────────────────────────────────────────────────────────────────────
// A confidently-wrong FIRST window is worse than an unpinned one: text-side followLanguage() then reads
// that hallucinated decode and (mis)pins the whole recording to it — a death spiral live Listen never
// sees because its 6s VAD windows and repetition guards keep whisper-base's per-window guess honest.
// Parakeet has no per-window audio-language guess to get wrong (it decodes all 25 of its languages the
// same way, no `language` option exists), so probing it once — for the FIRST window of a job, only while
// still in 'auto' — and running the SAME text language-ID the follow machine already trusts over its
// output is a steadier signal than whisper-base's own first guess. The probe only ever gains a pin; an
// unsure identification or a failed probe (model missing, native addon absent, a language outside
// Parakeet's set) leaves 'auto' exactly as before.
export type LanguageProbe = (samples: Float32Array) => Promise<string>

/** Runs once per job, immediately before window 1 would decode. Caller (index.ts) supplies `probe` —
 *  whisper-import.ts stays decoupled from parakeet.ts; the probe is wired in as a plain callback, so this
 *  is testable with a fake probe instead of a loaded Parakeet model. */
export async function probeLanguage(samples: Float32Array, probe?: LanguageProbe): Promise<void> {
  if (!probe || userLanguage !== 'auto' || windowCount !== 0) return
  let text: string
  try {
    text = await probe(samples)
  } catch (e) {
    mainLog.warn(`[whisper-import] language probe failed, keeping auto: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  const detected = detectLanguage(text).lang
  if (detected) activeLang = detected // pin immediately: window 1 already decodes with the right language
}

/** Collapses an intra-window decoder loop (the same runaway-repeat guard live Listen's worker applies —
 *  shared/transcript-filter.ts, added after the Portuguese RCA) before the text reaches followLanguage or
 *  the saved transcript, then advances the follow machine on the CLEANED text. Imports decode 12s slabs
 *  with no VAD trim and no live repetition guard, so a stuck decoder can loop far longer than the ~6s live
 *  windows ever allow — this is what stands between that loop and a transcript line repeated 100+ times.
 *  A standalone export for the same reason nextDecodeOptions/followLanguage are: testable without a
 *  loaded model. */
export function finalizeDecodedText(rawText: string): string {
  const text = collapseRepeatedPhrase(rawText.trim())
  if (text) followLanguage(text)
  return text
}

/**
 * Transcribes one already-decoded 16kHz mono PCM window of an import job. `language` is the current
 * settings.asrLanguage value ('auto' or a Whisper language name) — the caller reads it fresh on every
 * chunk (see index.ts's initializeImportJobs) so a mid-import Settings change is honored without
 * discarding an in-progress follow. `probe`, when the caller supplies one, is given one shot at pinning
 * the recording's language before window 1 decodes (see probeLanguage above).
 */
export async function whisperImportTranscribe(samples: Float32Array, language: string, probe?: LanguageProbe): Promise<string> {
  applyInitLanguage(language)
  await probeLanguage(samples, probe)
  const model = await ensureAsr()
  const opts = nextDecodeOptions()
  const out: any = await model(samples, opts)
  const rawText = Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text || ''
  return finalizeDecodedText(rawText)
}
