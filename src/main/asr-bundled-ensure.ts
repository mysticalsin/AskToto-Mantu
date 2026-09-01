/**
 * Ensure the high-accuracy Parakeet artifact (and speaker weights the product already uses) exist
 * on a runnable Métis.
 *
 * Bundled resources are first. If they are missing (dev checkout before fetch-models, or a damaged
 * installer), fetch the reviewed files into userData/asr-models and load from there. Progress is
 * reported. Ready is true only when the required files exist on disk — never a stub, never a skip,
 * never "Connected" with missing weights. A failed download stays an error until Retry.
 */
import { app, net } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import { mainLog } from './logger'

const execFileAsync = promisify(execFile)

/** High-accuracy Parakeet TDT 0.6B v3 (int8 sherpa-onnx export). Not a stub. */
export const PARAKEET_MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
export const PARAKEET_REQUIRED_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt'
] as const
export const PARAKEET_ARCHIVE_URL =
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET_MODEL_NAME}.tar.bz2`

/** CAM++ speaker embedding the live/import speaker-id path already loads. */
export const SPEAKER_WEIGHTS_REL = join('speaker', 'embedding.onnx')
export const SPEAKER_WEIGHTS_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx'

export const WHISPER_FLOOR_ID = 'Xenova/whisper-base'
export const WHISPER_FLOOR_REQUIRED_FILES = [
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json'
] as const

const HF_BASE = `https://huggingface.co/${WHISPER_FLOOR_ID}/resolve/main`
const REQUEST_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 120_000

export const ASR_ASSETS_MISSING =
  'Could not get the high-accuracy Parakeet files. Check your connection and try again.'

export interface AsrAssetsProgress {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  progress: number
  label: string
  error?: string
}

export interface AsrEnsureTestHooks {
  fetchParakeet?: (destDir: string, onProgress?: (pct: number) => void) => Promise<void>
  fetchSpeaker?: (destPath: string, onProgress?: (pct: number) => void) => Promise<void>
  fetchWhisperFloor?: (destDir: string, onProgress?: (pct: number) => void) => Promise<void>
}

let testHooks: AsrEnsureTestHooks | null = null
let inFlight: Promise<void> | null = null
let state: AsrAssetsProgress = { status: 'idle', progress: 0, label: '' }

export function setAsrEnsureTestHooks(hooks: AsrEnsureTestHooks | null): void {
  testHooks = hooks
}

export function resetAsrEnsureStateForTests(): void {
  inFlight = null
  state = { status: 'idle', progress: 0, label: '' }
}

export function asrAssetsProgress(): AsrAssetsProgress {
  return state
}

export function bundledResourceRoot(): string {
  const repo = join(__dirname, '..', '..')
  return app.isPackaged ? process.resourcesPath : join(repo, 'resources')
}

export function userDataAsrRoot(): string {
  return join(app.getPath('userData'), 'asr-models')
}

export function filePresent(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0
  } catch {
    return false
  }
}

export function parakeetFilesReady(dir: string): boolean {
  return PARAKEET_REQUIRED_FILES.every((name) => filePresent(join(dir, name)))
}

export function whisperFloorReady(modelsRoot: string): boolean {
  const dir = join(modelsRoot, ...WHISPER_FLOOR_ID.split('/'))
  return WHISPER_FLOOR_REQUIRED_FILES.every((name) => filePresent(join(dir, name)))
}

export function speakerWeightsPath(modelsRoot: string): string {
  return join(modelsRoot, SPEAKER_WEIGHTS_REL)
}

export function speakerWeightsReady(modelsRoot: string): boolean {
  return filePresent(speakerWeightsPath(modelsRoot))
}

export function parakeetBundledDir(): string {
  return join(bundledResourceRoot(), 'asr', PARAKEET_MODEL_NAME)
}

export function parakeetUserDir(): string {
  return join(userDataAsrRoot(), PARAKEET_MODEL_NAME)
}

/** Bundled copy if complete, else the userData copy (which may still be incomplete). */
export function resolveParakeetDir(): string {
  if (parakeetFilesReady(parakeetBundledDir())) return parakeetBundledDir()
  if (parakeetFilesReady(parakeetUserDir())) return parakeetUserDir()
  return parakeetBundledDir()
}

export function resolveSpeakerModelsRoot(): string {
  const bundled = join(bundledResourceRoot(), 'models')
  if (speakerWeightsReady(bundled)) return bundled
  if (speakerWeightsReady(userDataAsrRoot())) return userDataAsrRoot()
  return bundled
}

/** Root that contains Xenova/whisper-base. Packaged `models/` or userData `asr-models/`. */
export function resolveWhisperModelsRoot(): string {
  const bundled = join(bundledResourceRoot(), 'models')
  if (whisperFloorReady(bundled)) return bundled
  if (whisperFloorReady(userDataAsrRoot())) return userDataAsrRoot()
  return bundled
}

/** High-accuracy Parakeet on disk, plus speaker weights the product already uses. */
export function highAccuracyParakeetReady(): boolean {
  return parakeetFilesReady(resolveParakeetDir()) && speakerWeightsReady(resolveSpeakerModelsRoot())
}

/** Renderer-safe snapshot. Ready is only true when the required files exist. */
export function asrAssetsStatusSnapshot(): AsrAssetsProgress & { ready: boolean } {
  if (highAccuracyParakeetReady()) {
    return { ready: true, status: 'ready', progress: 1, label: 'High-accuracy Parakeet ready' }
  }
  const status = state.status === 'ready' ? 'idle' : state.status
  return {
    ready: false,
    status,
    progress: status === 'downloading' || status === 'error' ? state.progress : 0,
    label: state.label || 'Getting the high-accuracy Parakeet files…',
    error: status === 'error' ? state.error : undefined
  }
}

function publish(next: AsrAssetsProgress, onProgress?: (pct: number) => void): void {
  state = next
  if (next.status === 'downloading' || next.status === 'ready') onProgress?.(Math.round(next.progress * 100))
}

async function downloadTo(url: string, dest: string, onChunk?: (n: number, total: number) => void): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  rmSync(partial, { force: true })

  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number, why: string): void => {
    clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(new Error(why)), ms)
  }
  arm(REQUEST_TIMEOUT_MS, `request timeout for ${url}`)

  try {
    const res = await net.fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    if (!res.body) throw new Error(`empty body for ${url}`)
    const declared = Number(res.headers.get('content-length') || 0)
    const reader = res.body.getReader()
    arm(IDLE_TIMEOUT_MS, `stalled downloading ${url}`)
    let got = 0
    await pipeline(
      Readable.from(
        (async function* () {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) return
            if (!value) continue
            got += value.byteLength
            arm(IDLE_TIMEOUT_MS, `stalled downloading ${url}`)
            onChunk?.(got, declared)
            yield value
          }
        })()
      ),
      createWriteStream(partial)
    )
    const size = statSync(partial).size
    if (declared && size !== declared) throw new Error(`incomplete download: got ${size} of ${declared} bytes`)
    if (size <= 0) throw new Error(`empty download for ${url}`)
    renameSync(partial, dest)
  } catch (err) {
    ctrl.abort()
    rmSync(partial, { force: true })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

async function extractTarBz2(archive: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  await execFileAsync('tar', ['xjf', archive, '-C', destDir])
}

async function fetchParakeetToUserData(onProgress?: (pct: number) => void): Promise<void> {
  const destDir = parakeetUserDir()
  if (parakeetFilesReady(destDir)) return
  if (testHooks?.fetchParakeet) {
    await testHooks.fetchParakeet(destDir, onProgress)
    if (!parakeetFilesReady(destDir)) throw new Error(ASR_ASSETS_MISSING)
    return
  }

  mkdirSync(userDataAsrRoot(), { recursive: true })
  const archive = join(userDataAsrRoot(), `${PARAKEET_MODEL_NAME}.tar.bz2`)
  publish({ status: 'downloading', progress: 0.02, label: 'Getting the high-accuracy Parakeet files…' }, onProgress)
  await downloadTo(PARAKEET_ARCHIVE_URL, archive, (got, total) => {
    const frac = total ? Math.min(0.85, got / total) : 0.3
    publish({ status: 'downloading', progress: frac, label: 'Getting the high-accuracy Parakeet files…' }, onProgress)
  })
  publish({ status: 'downloading', progress: 0.88, label: 'Preparing the high-accuracy Parakeet files…' }, onProgress)
  await extractTarBz2(archive, userDataAsrRoot())
  rmSync(archive, { force: true })
  if (!parakeetFilesReady(destDir)) throw new Error(ASR_ASSETS_MISSING)
}

async function fetchSpeakerToUserData(onProgress?: (pct: number) => void): Promise<void> {
  if (speakerWeightsReady(resolveSpeakerModelsRoot())) return
  const dest = speakerWeightsPath(userDataAsrRoot())
  if (testHooks?.fetchSpeaker) {
    await testHooks.fetchSpeaker(dest, onProgress)
    if (!filePresent(dest)) throw new Error(ASR_ASSETS_MISSING)
    return
  }
  mkdirSync(dirname(dest), { recursive: true })
  publish({ status: 'downloading', progress: 0.9, label: 'Getting speaker files…' }, onProgress)
  await downloadTo(SPEAKER_WEIGHTS_URL, dest)
  if (!filePresent(dest)) throw new Error(ASR_ASSETS_MISSING)
}

async function fetchWhisperFloorToUserData(onProgress?: (pct: number) => void): Promise<void> {
  const destRoot = userDataAsrRoot()
  if (whisperFloorReady(join(bundledResourceRoot(), 'models')) || whisperFloorReady(destRoot)) return
  if (testHooks?.fetchWhisperFloor) {
    await testHooks.fetchWhisperFloor(destRoot, onProgress)
    return
  }

  const destDir = join(destRoot, ...WHISPER_FLOOR_ID.split('/'))
  mkdirSync(destDir, { recursive: true })
  let done = 0
  const total = WHISPER_FLOOR_REQUIRED_FILES.length
  for (const rel of WHISPER_FLOOR_REQUIRED_FILES) {
    const dest = join(destDir, rel)
    if (filePresent(dest)) {
      done += 1
      publish(
        { status: 'downloading', progress: 0.92 + (done / total) * 0.06, label: 'Getting the Whisper floor…' },
        onProgress
      )
      continue
    }
    await downloadTo(`${HF_BASE}/${rel}`, dest)
    done += 1
    publish(
      { status: 'downloading', progress: 0.92 + (done / total) * 0.06, label: 'Getting the Whisper floor…' },
      onProgress
    )
  }
}

export async function ensureParakeetAssets(onProgress?: (pct: number) => void): Promise<void> {
  if (parakeetFilesReady(parakeetBundledDir()) || parakeetFilesReady(parakeetUserDir())) {
    onProgress?.(100)
    return
  }
  await fetchParakeetToUserData(onProgress)
}

export async function ensureSpeakerAssets(onProgress?: (pct: number) => void): Promise<void> {
  if (speakerWeightsReady(resolveSpeakerModelsRoot())) {
    onProgress?.(100)
    return
  }
  await fetchSpeakerToUserData(onProgress)
}

export async function ensureWhisperFloorAssets(onProgress?: (pct: number) => void): Promise<void> {
  const bundled = join(bundledResourceRoot(), 'models')
  if (whisperFloorReady(bundled) || whisperFloorReady(userDataAsrRoot())) {
    onProgress?.(100)
    return
  }
  await fetchWhisperFloorToUserData(onProgress)
}

/** One shared ensure for onboarding. Concurrent callers share the transfer. Retry after error starts fresh. */
export function ensureHighAccuracyParakeet(onProgress?: (pct: number) => void): Promise<void> {
  if (inFlight) return inFlight
  inFlight = runEnsure(onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Alias used by import / listen / onboarding IPC. */
export const ensureImportAsrAssets = ensureHighAccuracyParakeet

async function runEnsure(onProgress?: (pct: number) => void): Promise<void> {
  if (highAccuracyParakeetReady()) {
    publish({ status: 'ready', progress: 1, label: 'High-accuracy Parakeet ready' }, onProgress)
    return
  }
  try {
    publish({ status: 'downloading', progress: 0, label: 'Getting the high-accuracy Parakeet files…' }, onProgress)
    await ensureParakeetAssets((pct) => {
      publish(
        { status: 'downloading', progress: (pct / 100) * 0.8, label: 'Getting the high-accuracy Parakeet files…' },
        onProgress
      )
    })
    await ensureSpeakerAssets((pct) => {
      publish(
        { status: 'downloading', progress: 0.8 + (pct / 100) * 0.12, label: 'Getting speaker files…' },
        onProgress
      )
    })
    try {
      await ensureWhisperFloorAssets()
    } catch (e) {
      // Whisper is the default working engine; a missing floor must not block Parakeet onboarding.
      mainLog.warn('[asr-assets] Whisper floor ensure failed (non-blocking):', e instanceof Error ? e.message : e)
    }
    if (!highAccuracyParakeetReady()) throw new Error(ASR_ASSETS_MISSING)
    publish({ status: 'ready', progress: 1, label: 'High-accuracy Parakeet ready' }, onProgress)
    mainLog.info('[asr-assets] high-accuracy Parakeet ready on disk')
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const message = /reinstall/i.test(error) ? ASR_ASSETS_MISSING : error || ASR_ASSETS_MISSING
    publish({ status: 'error', progress: state.progress, label: message, error: message }, onProgress)
    mainLog.warn('[asr-assets] ensure failed:', message)
    throw new Error(message)
  }
}
