/**
 * Main-process side of import transcription: the adaptive language-follow machine (ported from the
 * renderer's whisper.worker.ts) plus an RPC client to the whisper utilityProcess.
 *
 * MQA-234: the transformers/onnxruntime-node stack must NEVER load into the main process — sherpa-onnx
 * (Parakeet, speaker-id) lives there, both ship an `onnxruntime` DLL under the same name, and whichever
 * loads second is broken (at require, or worse: a native crash at first decode — both directions proven
 * in the packaged app; a load-order fix was shipped and reverted the same day when the packaged-ASR gate
 * caught the crash). So the model runs in an Electron utilityProcess (whisper-asr-host.ts) and this
 * module only ships Float32 windows across and text back. A dead/failed child rejects the in-flight
 * request; index.ts's transcribe seam keeps its existing "engine choice must never fail an import"
 * Parakeet fallback, exactly as before.
 */
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { detectLanguage, LANGUAGE_NAMES } from '@shared/lang-id'
import { collapseRepeatedPhrase } from '@shared/transcript-filter'
import { mainLog } from './logger'
import { getSettings, setSettings } from './store'
import { asrModelRoot } from './asr-model-download'

/** resources/models — same directory the renderer's asr-model:// protocol serves from. Resolved here
 *  and handed to the child in its init message, so the child needs no packaged/dev path logic. */
function modelsDir(): string {
  const REPO_ROOT = join(__dirname, '..', '..')
  const base = app.isPackaged ? process.resourcesPath : join(REPO_ROOT, 'resources')
  return join(base, 'models')
}

// ── Whisper utilityProcess client ────────────────────────────────────────────────────────────────────
const HOST_REQUEST_TIMEOUT_MS = 180_000 // whisper-base on CPU decodes a ≤20s window in seconds; 3min is a hang, not a slow decode

interface PendingRequest {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

let host: UtilityProcess | null = null
let hostReady = false
let nextRequestId = 1
const pending = new Map<number, PendingRequest>()

function failAllPending(message: string): void {
  for (const [, req] of pending) {
    clearTimeout(req.timer)
    req.reject(new Error(message))
  }
  pending.clear()
}

function ensureHost(): UtilityProcess {
  if (host) return host
  const child = utilityProcess.fork(join(__dirname, 'whisper-asr-host.js'), [], {
    serviceName: 'metis-whisper-import',
    stdio: 'pipe'
  })
  child.stderr?.on('data', (chunk: Buffer) => mainLog.warn('[whisper-host]', chunk.toString('utf8').trim()))
  child.stdout?.on('data', () => {})
  child.on('message', (msg: unknown) => {
    const m = msg as { type?: string; id?: number; text?: string; message?: string; tier?: string; degraded?: boolean }
    if (m?.type === 'ready') {
      hostReady = true
      // MQA-246: an import that ran on the floor transcription model must be visible somewhere. The live
      // path already has this contract for its own engine swap (settings.asrLastFallbackAt, surfaced in
      // Settings until dismissed); imports had nothing, so a recording transcribed by the weakest model
      // looked identical to one transcribed by the best. Same after-the-fact note, never a live banner.
      mainLog.info(`[whisper-host] transcription tier: ${m.tier ?? 'unknown'}${m.degraded ? ' (degraded — high tier not present)' : ''}`)
      if (m.degraded) {
        try {
          if (getSettings().asrImportTierFallbackAt == null) setSettings({ asrImportTierFallbackAt: Date.now() })
        } catch (e) {
          mainLog.warn('[whisper-host] could not record the transcription-tier note:', e)
        }
      }
      return
    }
    if ((m?.type === 'result' || m?.type === 'error') && typeof m.id === 'number') {
      const req = pending.get(m.id)
      if (!req) return
      pending.delete(m.id)
      clearTimeout(req.timer)
      if (m.type === 'result') req.resolve(m.text ?? '')
      else req.reject(new Error(m.message || 'Whisper transcription failed.'))
    }
  })
  child.on('exit', (code) => {
    // A crashed/killed child (OOM, native fault) must fail fast, not hang the import until timeout —
    // and the NEXT transcribe call gets a fresh child rather than a dead handle.
    if (host === child) {
      host = null
      hostReady = false
    }
    failAllPending(`The transcription helper exited unexpectedly (code ${code ?? 'unknown'}).`)
  })
  // MQA-247: both roots — the packaged floor and the per-user profile the high tier is fetched into.
  // Resolved defensively: if the profile path is unavailable for any reason, an import must still run
  // on the bundled floor rather than fail outright. Losing the better model is a degradation; losing
  // transcription is an outage, and this module already treats the floor as the always-available path.
  let fetchedModelsPath: string | undefined
  try {
    fetchedModelsPath = asrModelRoot()
  } catch (e) {
    mainLog.warn('[whisper-host] no fetched-model root; the bundled floor is the only tier:', e)
  }
  child.postMessage({ type: 'init', modelsPath: modelsDir(), ...(fetchedModelsPath ? { fetchedModelsPath } : {}) })
  host = child
  hostReady = false
  return child
}

/** Stop the helper and free its ~300MB of model memory. Called by the import pipeline at job end; the
 *  next import simply spawns a fresh child. Safe to call when no host is running. */
export function stopWhisperHost(): void {
  const child = host
  host = null
  hostReady = false
  if (child) {
    failAllPending('Import cancelled.')
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
}

function transcribeRemote(samples: Float32Array, language?: string, task?: string): Promise<string> {
  const child = ensureHost()
  const id = nextRequestId++
  // Copy into an owned, transfer-safe buffer: `samples` may be a view over a decoder buffer the caller
  // reuses, and postMessage's structured clone must see a stable snapshot.
  const pcm = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength)
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Whisper transcription timed out.'))
    }, HOST_REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    try {
      child.postMessage({ type: 'transcribe', id, pcm, ...(language ? { language } : {}), ...(task ? { task } : {}) })
    } catch (e) {
      pending.delete(id)
      clearTimeout(timer)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}
void hostReady // informational only today; kept for a future readiness gate without changing the protocol

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
  probePinned = false
  reprobeRun = null
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
  // Text-side following only ever steers the probe-less 'auto' path (see nextDecodeOptions's block
  // comment): an explicit user language must never be second-guessed from decoded text, and once the
  // Parakeet probe owns the pin every window is pinned-language-shaped by construction — text signals
  // from either state can only be false. Intrinsic here, not just at the finalize call site.
  if (userLanguage !== 'auto' || probePinned) return
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

/** This window's decode options, and advances windowCount — adapted from whisper.worker.ts's per-window
 *  decision with ONE load-bearing difference, learned the hard way (2026-08-05, real French import):
 *  transformers.js's whisper does NOT auto-detect language on an un-pinned call — it logs "No language
 *  specified - defaulting to English" and decodes ENGLISH. The worker's "un-pinned probe window" design
 *  therefore cannot work here: a probe window decodes English junk into the saved transcript, text-side
 *  lang-id reads that junk as a genuine English switch, and two windows later the whole file re-pins to
 *  English (observed live: probe pinned French at window 3, output was English throughout). So: once a
 *  language is known — from the Parakeet probe (probePinned) or an explicit setting — whisper NEVER
 *  decodes un-pinned again; mid-recording switches are detected by re-running the Parakeet probe
 *  (reprobeForSwitch below), which genuinely is language-agnostic. Un-pinned windows remain only in the
 *  probe-less 'auto' path, where they were already the pre-existing behavior. */
export function nextDecodeOptions(): { return_timestamps: boolean; language?: string; task?: string } {
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

/** A recording's opening windows are routinely silence, hold music, or one-word greetings — probing
 *  only window 0 pinned a real French meeting to ENGLISH off its "Hello" call-join chunk (whisper then
 *  quietly TRANSLATED the whole call, field evidence 2026-08-05). Keep probing early windows until one
 *  contains enough real speech for the text language-id to mean something, then pin. PROBE_WINDOW_BUDGET
 *  is an opening BURST, not a retirement — after it, probeLanguage keeps trying on the PROBE_EVERY cadence
 *  (see its guard below) rather than giving up, because an un-pinned whisper decode is hard-coded to
 *  English by transformers.js, so a probe that never landed must keep trying or the rest of a non-English
 *  import silently transcribes as English (MQA-106, mirroring listen.ts's shouldProbeLanguageWindow). */
const PROBE_WINDOW_BUDGET = 5
const PROBE_MIN_WORDS = 8
let probePinned = false

/** Runs before each early window decodes. Caller (index.ts) supplies `probe` — whisper-import.ts stays
 *  decoupled from parakeet.ts; the probe is wired in as a plain callback, so this is testable with a
 *  fake probe instead of a loaded Parakeet model. */
export async function probeLanguage(samples: Float32Array, probe?: LanguageProbe): Promise<void> {
  if (!probe || userLanguage !== 'auto' || probePinned) return
  // Burst-then-cadence, mirroring listen.ts's shouldProbeLanguageWindow (the MQA-012 live-path fix, ported
  // here for MQA-106). PROBE_WINDOW_BUDGET is an OPENING burst, not a permanent retirement: a >= cutoff
  // would stop probing forever once the budget is spent on short openers the PROBE_MIN_WORDS gate discards,
  // and every un-pinned window after that decodes English by construction (see nextDecodeOptions), silently
  // transcribing the rest of a non-English import as English. After the burst, keep probing on the steady
  // PROBE_EVERY cadence until a window finally lands a pin.
  if (windowCount > PROBE_WINDOW_BUDGET && windowCount % PROBE_EVERY !== 0) return
  let text: string
  try {
    text = await probe(samples)
  } catch (e) {
    mainLog.warn(`[whisper-import] language probe failed, keeping auto: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  // A near-empty window can only mislead: "Hello" alone reads as English regardless of the meeting's
  // real language. Wait for a window with substance before trusting the detection.
  if (text.trim().split(/\s+/).filter(Boolean).length < PROBE_MIN_WORDS) return
  const detected = detectLanguage(text).lang
  if (detected) {
    activeLang = detected // pin immediately: this window already decodes with the right language
    probePinned = true
    switchRun = null // text-side follow is retired once the probe owns the pin (see nextDecodeOptions)
    mainLog.info(`[whisper-import] language probe pinned '${detected}' at window ${windowCount}`)
  }
}

// Parakeet-driven switch detection: once probePinned, whisper always decodes pinned (see
// nextDecodeOptions), so mid-recording language switches are detected by re-running the Parakeet probe
// on every PROBE_EVERY-th window and confirming SWITCH_AFTER consecutive substantive detections of the
// same different language. Parakeet takes no language parameter, so unlike an un-pinned whisper window
// its output genuinely reflects what was spoken.
let reprobeRun: { lang: string; count: number } | null = null

export async function reprobeForSwitch(samples: Float32Array, probe?: LanguageProbe): Promise<void> {
  if (!probe || !probePinned || userLanguage !== 'auto') return
  if (windowCount === 0 || windowCount % PROBE_EVERY !== 0) return
  let text: string
  try {
    text = await probe(samples)
  } catch {
    return // a flaky re-probe must never disturb a working pin
  }
  if (text.trim().split(/\s+/).filter(Boolean).length < PROBE_MIN_WORDS) return
  const detected = detectLanguage(text).lang
  if (!detected || detected === activeLang) {
    reprobeRun = null // pin re-confirmed (or no signal) — false alarm
    return
  }
  if (reprobeRun && reprobeRun.lang === detected) {
    reprobeRun.count += 1
    if (reprobeRun.count >= SWITCH_AFTER) {
      mainLog.info(`[whisper-import] language switch: '${activeLang}' -> '${detected}' at window ${windowCount}`)
      activeLang = detected
      reprobeRun = null
    }
    return
  }
  reprobeRun = { lang: detected, count: 1 }
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
  // Text-side follow only steers the probe-less 'auto' path. Once the Parakeet probe owns the pin (or
  // the user pinned explicitly), every window decodes pinned-language-shaped text by construction —
  // feeding that back into text lang-id could only ever produce false switch signals.
  if (text && !probePinned && userLanguage === 'auto') followLanguage(text)
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
  await reprobeForSwitch(samples, probe)
  const opts = nextDecodeOptions()
  const rawText = await transcribeRemote(samples, opts.language, opts.task)
  return finalizeDecodedText(rawText)
}
