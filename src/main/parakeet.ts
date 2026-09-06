/**
 * Parakeet v3 ASR engine (NVIDIA NeMo TDT, 25 European languages, auto-detect) running on-device in the
 * MAIN process via the sherpa-onnx-node native addon (N-API — loads in Electron without a rebuild). It is
 * the opt-in "fastest, European" alternative to the default Whisper engine; if anything here is missing or
 * fails, the renderer silently falls back to Whisper, so this can never break live transcription.
 *
 * The model ships BUNDLED in the app's resources (resources/asr, populated by
 * `npm run fetch-models` / `npm run dev`'s ensure-asr-assets). If those files are somehow absent,
 * ensureParakeetModel fetches them into userData — never asks the user to reinstall.
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { mainLog } from './logger'
import {
  ASR_ASSETS_MISSING,
  PARAKEET_MODEL_NAME,
  ensureParakeetAssets,
  parakeetFilesReady,
  resolveParakeetDir
} from './asr-bundled-ensure'

const SAMPLE_RATE = 16000

/**
 * Return the model directory, preferring the bundled copy shipped inside the app's resources.
 * Falls back to a userData copy written by ensureParakeetAssets when the installer or checkout
 * is missing weights.
 */
function modelDir(): string {
  return resolveParakeetDir()
}
function modelFiles(): { encoder: string; decoder: string; joiner: string; tokens: string } {
  const d = modelDir()
  return {
    encoder: join(d, 'encoder.int8.onnx'),
    decoder: join(d, 'decoder.int8.onnx'),
    joiner: join(d, 'joiner.int8.onnx'),
    tokens: join(d, 'tokens.txt')
  }
}

/** True when all model files are present and are real weights — not Access login HTML. */
export function parakeetModelReady(): boolean {
  return parakeetFilesReady(modelDir())
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let recognizer: any = null
// Reason the native addon last failed to load (e.g. a cross-built package missing the platform's
// sherpa-onnx-<platform>-<arch> binary). Kept so parakeetTranscribe can throw something a caller can
// actually act on instead of the generic "recognizer unavailable".
let addonLoadError: string | null = null
// undefined = not probed yet; null = probed and require() threw; otherwise the loaded module.
// require() itself does not cache a *failed* load, so without this memo a repeated probe would repeat
// the native dlopen attempt (cheap, but not free) on every call instead of exactly once.
let addonModule: any = undefined

/** Probe (once, memoized forever — success or failure) whether sherpa-onnx-node's native addon loads.
 *  Just the require() — never touches model weights and spawns nothing, so it's cheap enough to run
 *  eagerly on the first status/transcribe call instead of only after a live transcribe has failed. */
function probeSherpa(): any | null {
  if (addonModule !== undefined) return addonModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    addonModule = require('sherpa-onnx-node')
    addonLoadError = null
  } catch (e) {
    addonModule = null
    addonLoadError = (e as Error)?.message || String(e)
    mainLog.error('[parakeet] sherpa-onnx-node failed to load:', addonLoadError)
  }
  return addonModule
}

/** Last native-addon load failure, if any — lets a caller tell "addon missing for this platform/build"
 * apart from "bundled model assets missing" when reporting Parakeet engine status. Triggers the memoized
 * probe on first call (see probeSherpa) so Settings shows an accurate status on mount instead of only
 * after a live transcribe has already failed — must stay cheap (no model load, no spawn) since it runs
 * on every parakeetStatus poll. */
export function parakeetAddonError(): string | null {
  probeSherpa()
  return addonLoadError
}

/** Require Parakeet weights. Bundled first; otherwise fetch into userData with visible progress.
 *  Also constructs the recognizer (MQA-285) so first Listen is not a multi-second sherpa load. */
export async function ensureParakeetModel(onProgress?: (pct: number) => void): Promise<void> {
  if (!parakeetModelReady()) {
    await ensureParakeetAssets(onProgress)
  }
  if (!parakeetModelReady()) throw new Error(ASR_ASSETS_MISSING)
  // Best-effort construct so a later Listen click is not a cold sherpa load. Skip stub/tiny
  // files (unit tests write "ok") — Ort aborts the process on a fake ONNX protobuf.
  try {
    const encoder = modelFiles().encoder
    if (existsSync(encoder) && statSync(encoder).size > 1024) getRecognizer()
  } catch {
    /* native probe or missing addon — Listen still falls back to Whisper */
  }
}

/** Construct (once) the offline recognizer for the Parakeet transducer model. */
function getRecognizer(): any | null {
  if (recognizer) return recognizer
  if (!parakeetModelReady()) return null
  const sherpa = probeSherpa()
  if (!sherpa) return null
  const f = modelFiles()
  try {
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
        tokens: f.tokens,
        numThreads: 2,
        provider: 'cpu',
        modelType: 'nemo_transducer',
        debug: 0
      },
      decodingMethod: 'greedy_search'
    })
    return recognizer
  } catch (e) {
    mainLog.error('[parakeet] recognizer construction failed:', (e as Error)?.message)
    return null
  }
}

/**
 * Transcribe one mono 16kHz Float32 PCM window → text.
 * THROWS if the engine is unavailable or decoding fails, so the renderer can tell a real failure apart from
 * silence and fall back to Whisper (an empty string here means genuine no-speech, NOT a failure).
 */
export async function parakeetTranscribe(samples: Float32Array): Promise<string> {
  const rec = getRecognizer()
  if (!rec) {
    throw new Error(
      addonLoadError ? `parakeet native addon unavailable: ${addonLoadError}` : 'parakeet recognizer unavailable'
    )
  }
  try {
    const stream = rec.createStream()
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
    await rec.decodeAsync(stream)
    const r = rec.getResult(stream)
    return (r?.text || '').trim() // '' = genuine silence/no speech
  } catch (e) {
    mainLog.error('[parakeet] transcribe failed:', (e as Error)?.message)
    throw e instanceof Error ? e : new Error(String(e)) // surface to renderer → Whisper fallback
  }
}

/** Teardown names sherpa-onnx-node might grow. The shipped OfflineRecognizer exposes NONE of them —
 *  hence the feature test below rather than an optional call, which silently no-ops forever. */
const TEARDOWN_METHODS = ['free', 'destroy', 'dispose'] as const

/**
 * Run one full GC so the recognizer wrapper's napi finalizer — the only thing that frees the native
 * weights — runs at the meeting boundary instead of whenever the main process happens to allocate enough
 * JS. The addon never calls napi_adjust_external_memory, so V8 sees a few bytes of wrapper and has no
 * allocation pressure linking it to ~600MB of ONNX weights; without this the release is unbounded in
 * time. Electron does not boot with --expose-gc, so the flag is flipped for the call and put back.
 */
function collectNativeGarbage(): void {
  try {
    const exposed = (globalThis as { gc?: () => void }).gc
    if (exposed) {
      exposed()
      return
    }
    try {
      setFlagsFromString('--expose-gc')
      ;(runInNewContext('gc') as () => void)()
    } finally {
      setFlagsFromString('--no-expose-gc')
    }
  } catch {
    /* best-effort — a hardened V8 may refuse the flag; the finalizer then waits for the next full GC */
  }
}

/**
 * Free the recognizer (between meetings / on idle) to release memory.
 *
 * Dropping the JS reference is NOT enough: sherpa's OfflineRecognizer has no teardown, so the ~600MB of
 * native weights survive until V8 finalizes the wrapper — which, with no external-memory pressure
 * registered, may be never in a quiet main process. The next meeting then builds a SECOND recognizer on
 * top of the first. So: call a real teardown if this sherpa build has one, then force the collection.
 */
export function parakeetRelease(): void {
  const rec = recognizer
  recognizer = null
  if (!rec) return
  try {
    const teardown = TEARDOWN_METHODS.find((m) => typeof rec[m] === 'function')
    if (teardown) rec[teardown]()
  } catch {
    /* best-effort */
  }
  collectNativeGarbage()
}

export { PARAKEET_MODEL_NAME }
