/**
 * Ensure Parakeet + the Whisper floor exist on a runnable Métis.
 *
 * Bundled resources are first. If they are missing (dev checkout before fetch-models, or a damaged
 * installer), fetch the reviewed files into userData/asr-models and load from there. Progress is
 * reported; the user is never told to reinstall for missing weights.
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

export const PARAKEET_MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
export const PARAKEET_REQUIRED_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt'
] as const
export const PARAKEET_ARCHIVE_URL =
  `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET_MODEL_NAME}.tar.bz2`

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
  'Could not get the transcription files. Check your connection and try again.'

export interface AsrAssetsProgress {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  progress: number
  label: string
  error?: string
}

export interface AsrEnsureTestHooks {
  fetchParakeet?: (destDir: string, onProgress?: (pct: number) => void) => Promise<void>
  fetchWhisperFloor?: (destDir: string, onProgress?: (pct: number) => void) => Promise<void>
}

let testHooks: AsrEnsureTestHooks | null = null
let inFlight: Promise<void> | null = null
let state: AsrAssetsProgress = { status: 'idle', progress: 0, label: '' }

export function setAsrEnsureTestHooks(hooks: AsrEnsureTestHooks | null): void {
  testHooks = hooks
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

/** Root that contains Xenova/whisper-base. Packaged `models/` or userData `asr-models/`. */
export function resolveWhisperModelsRoot(): string {
  const bundled = join(bundledResourceRoot(), 'models')
  if (whisperFloorReady(bundled)) return bundled
  if (whisperFloorReady(userDataAsrRoot())) return userDataAsrRoot()
  return bundled
}

export function importAsrAssetsReady(): boolean {
  return parakeetFilesReady(resolveParakeetDir()) && whisperFloorReady(resolveWhisperModelsRoot())
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
    return
  }

  mkdirSync(userDataAsrRoot(), { recursive: true })
  const archive = join(userDataAsrRoot(), `${PARAKEET_MODEL_NAME}.tar.bz2`)
  publish({ status: 'downloading', progress: 0.02, label: 'Getting transcription files…' }, onProgress)
  await downloadTo(PARAKEET_ARCHIVE_URL, archive, (got, total) => {
    const frac = total ? Math.min(0.9, got / total) : 0.3
    publish({ status: 'downloading', progress: frac, label: 'Getting transcription files…' }, onProgress)
  })
  publish({ status: 'downloading', progress: 0.92, label: 'Preparing transcription files…' }, onProgress)
  await extractTarBz2(archive, userDataAsrRoot())
  rmSync(archive, { force: true })
  if (!parakeetFilesReady(destDir)) throw new Error(ASR_ASSETS_MISSING)
}

async function fetchWhisperFloorToUserData(onProgress?: (pct: number) => void): Promise<void> {
  const destRoot = userDataAsrRoot()
  if (whisperFloorReady(destRoot)) return
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
        { status: 'downloading', progress: done / total, label: 'Getting transcription files…' },
        onProgress
      )
      continue
    }
    await downloadTo(`${HF_BASE}/${rel}`, dest)
    done += 1
    publish(
      { status: 'downloading', progress: done / total, label: 'Getting transcription files…' },
      onProgress
    )
  }
  if (!whisperFloorReady(destRoot)) throw new Error(ASR_ASSETS_MISSING)
}

export async function ensureParakeetAssets(onProgress?: (pct: number) => void): Promise<void> {
  if (parakeetFilesReady(parakeetBundledDir()) || parakeetFilesReady(parakeetUserDir())) {
    onProgress?.(100)
    return
  }
  await fetchParakeetToUserData(onProgress)
}

export async function ensureWhisperFloorAssets(onProgress?: (pct: number) => void): Promise<void> {
  const bundled = join(bundledResourceRoot(), 'models')
  if (whisperFloorReady(bundled) || whisperFloorReady(userDataAsrRoot())) {
    onProgress?.(100)
    return
  }
  await fetchWhisperFloorToUserData(onProgress)
}

/** One shared ensure for import + live Parakeet. Concurrent callers share the transfer. */
export function ensureImportAsrAssets(onProgress?: (pct: number) => void): Promise<void> {
  if (inFlight) return inFlight
  inFlight = runEnsure(onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runEnsure(onProgress?: (pct: number) => void): Promise<void> {
  if (importAsrAssetsReady()) {
    publish({ status: 'ready', progress: 1, label: 'Transcription files ready' }, onProgress)
    return
  }
  try {
    publish({ status: 'downloading', progress: 0, label: 'Getting transcription files…' }, onProgress)
    await ensureParakeetAssets((pct) => {
      publish(
        { status: 'downloading', progress: (pct / 100) * 0.75, label: 'Getting transcription files…' },
        onProgress
      )
    })
    await ensureWhisperFloorAssets((pct) => {
      publish(
        { status: 'downloading', progress: 0.75 + (pct / 100) * 0.25, label: 'Getting transcription files…' },
        onProgress
      )
    })
    if (!importAsrAssetsReady()) throw new Error(ASR_ASSETS_MISSING)
    publish({ status: 'ready', progress: 1, label: 'Transcription files ready' }, onProgress)
    mainLog.info('[asr-assets] Parakeet and Whisper floor ready')
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const message = /reinstall/i.test(error) ? ASR_ASSETS_MISSING : error || ASR_ASSETS_MISSING
    publish({ status: 'error', progress: state.progress, label: message, error: message }, onProgress)
    mainLog.warn('[asr-assets] ensure failed:', message)
    throw new Error(message)
  }
}
