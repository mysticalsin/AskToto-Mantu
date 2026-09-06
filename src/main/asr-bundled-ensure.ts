/**
 * Ensure Parakeet + the Whisper floor exist on a runnable Métis.
 *
 * Bundled resources are first. If they are missing (dev checkout before fetch-models, or a damaged
 * installer), fetch the reviewed files into userData/asr-models and load from there. Progress is
 * reported; the user is never told to reinstall for missing weights.
 */
import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import {
  BUNDLE_GOT_LOGIN_HTML,
  BUNDLE_NETWORK,
  bundleFailureUserMessage,
  bundleKindForUrl,
  inspectBundleResponse,
  looksLikeAccessRedirect,
  looksLikeHtmlBytes
} from '@shared/bundle-response'
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

/** Pinned Parakeet release archive (sha256 of the .tar.bz2). Recorded 2026-09-06. */
export const PARAKEET_ARCHIVE_BYTES = 487170055
export const PARAKEET_ARCHIVE_SHA256 =
  '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf'

/** Post-extract pins for the four required Parakeet files (from the pinned archive). */
export const PARAKEET_FILE_PINS = [
  { name: 'encoder.int8.onnx', bytes: 652184281, sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247' },
  { name: 'decoder.int8.onnx', bytes: 11845275, sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e' },
  { name: 'joiner.int8.onnx', bytes: 6355277, sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3' },
  { name: 'tokens.txt', bytes: 93939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' }
] as const

export const WHISPER_FLOOR_ID = 'Xenova/whisper-base'
/** Immutable Hugging Face commit for the Whisper floor (never main). */
export const WHISPER_FLOOR_REVISION = '64da57285918e20ea79ea5c88eed7197933abaa8'
export const WHISPER_FLOOR_REQUIRED_FILES = [
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json'
] as const

/** Size + sha256 pins for Whisper floor downloads. ONNX digests are HF LFS oids; others hashed 2026-09-06. */
export const WHISPER_FLOOR_FILE_PINS = [
  { path: 'onnx/encoder_model_quantized.onnx', bytes: 23200850, sha256: '3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9' },
  { path: 'onnx/decoder_model_merged_quantized.onnx', bytes: 53707539, sha256: 'a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861' },
  { path: 'config.json', bytes: 2248, sha256: 'd1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b' },
  { path: 'generation_config.json', bytes: 3776, sha256: '3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05' },
  { path: 'tokenizer.json', bytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
  { path: 'tokenizer_config.json', bytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
  { path: 'preprocessor_config.json', bytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' }
] as const

const HF_BASE = `https://huggingface.co/${WHISPER_FLOOR_ID}/resolve/${WHISPER_FLOOR_REVISION}`
const REQUEST_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 120_000
const MAX_REDIRECTS = 8

export type DownloadPin = { bytes?: number; sha256: string }

export function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export async function assertPinnedFile(path: string, pin: DownloadPin): Promise<void> {
  const size = statSync(path).size
  if (pin.bytes != null && size !== pin.bytes) {
    throw new Error(`${path}: got ${size} bytes, expected ${pin.bytes}`)
  }
  const digest = await sha256Of(path)
  if (digest !== pin.sha256) {
    throw new Error(
      `${path}: sha256 ${digest.slice(0, 12)}… does not match the pinned ${pin.sha256.slice(0, 12)}…`
    )
  }
}


/** Follow https hops. Access 302 HTML is never a bundle. */
export async function fetchBundleResponse(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof net.fetch = net.fetch
): Promise<Response> {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(current, { signal })
    if (res.status < 300 || res.status >= 400) return res
    const loc = res.headers.get('location')
    if (!loc) return res
    if (looksLikeAccessRedirect(loc)) throw new Error(BUNDLE_GOT_LOGIN_HTML)
    const next = new URL(loc, current).toString()
    if (!/^https:\/\//i.test(next)) throw new Error(BUNDLE_NETWORK)
    current = next
  }
  throw new Error(BUNDLE_NETWORK)
}

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

function fileLooksLikeHtml(path: string): boolean {
  let fd = -1
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(512)
    const n = readSync(fd, buf, 0, 512, 0)
    return looksLikeHtmlBytes(buf.subarray(0, n))
  } catch {
    return false
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
}

export function filePresent(path: string): boolean {
  try {
    if (!existsSync(path) || statSync(path).size <= 0) return false
    // Access login HTML written as .onnx / .js / .json is not a bundle.
    return !fileLooksLikeHtml(path)
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

/** Renderer-safe snapshot: bundled or userData, never a reinstall string. */
export function asrAssetsStatusSnapshot(): AsrAssetsProgress & { ready: boolean } {
  if (importAsrAssetsReady()) {
    return { ready: true, status: 'ready', progress: 1, label: 'Transcription files ready' }
  }
  const status = state.status === 'ready' ? 'idle' : state.status
  return {
    ready: false,
    status,
    progress: status === 'downloading' || status === 'error' ? state.progress : 0,
    label: state.label || 'Getting transcription files…',
    error: status === 'error' ? state.error : undefined
  }
}

function publish(next: AsrAssetsProgress, onProgress?: (pct: number) => void): void {
  state = next
  if (next.status === 'downloading' || next.status === 'ready') onProgress?.(Math.round(next.progress * 100))
}

async function downloadTo(
  url: string,
  dest: string,
  onChunk?: (n: number, total: number) => void,
  pin?: DownloadPin
): Promise<void> {
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
    const res = await fetchBundleResponse(url, ctrl.signal)
    const inspected = inspectBundleResponse({
      status: res.status,
      contentType: res.headers.get('content-type'),
      location: res.headers.get('location'),
      expected: bundleKindForUrl(url)
    })
    if (!inspected.ok) throw new Error(inspected.message)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    if (!res.body) throw new Error(`empty body for ${url}`)
    const declared = Number(res.headers.get('content-length') || 0)
    const reader = res.body.getReader()
    const first = await reader.read()
    if (first.value && looksLikeHtmlBytes(first.value)) {
      await reader.cancel().catch(() => undefined)
      throw new Error(BUNDLE_GOT_LOGIN_HTML)
    }
    arm(IDLE_TIMEOUT_MS, `stalled downloading ${url}`)
    let got = first.value?.byteLength ?? 0
    if (first.value) onChunk?.(got, declared)
    await pipeline(
      Readable.from(
        (async function* () {
          if (first.value) yield first.value
          if (first.done) return
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
    if (pin?.bytes != null && size !== pin.bytes) {
      throw new Error(`incomplete download: got ${size} of ${pin.bytes} pinned bytes`)
    }
    if (size <= 0) throw new Error(`empty download for ${url}`)
    if (pin?.sha256) {
      const digest = await sha256Of(partial)
      if (digest !== pin.sha256) {
        throw new Error(
          `sha256 ${digest.slice(0, 12)}… does not match the pinned ${pin.sha256.slice(0, 12)}…`
        )
      }
    }
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
  await downloadTo(
    PARAKEET_ARCHIVE_URL,
    archive,
    (got, total) => {
      const frac = total ? Math.min(0.9, got / total) : 0.3
      publish({ status: 'downloading', progress: frac, label: 'Getting transcription files…' }, onProgress)
    },
    { bytes: PARAKEET_ARCHIVE_BYTES, sha256: PARAKEET_ARCHIVE_SHA256 }
  )
  publish({ status: 'downloading', progress: 0.92, label: 'Preparing transcription files…' }, onProgress)
  await extractTarBz2(archive, userDataAsrRoot())
  rmSync(archive, { force: true })
  for (const pin of PARAKEET_FILE_PINS) {
    await assertPinnedFile(join(destDir, pin.name), pin)
  }
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
    const pin = WHISPER_FLOOR_FILE_PINS.find((f) => f.path === rel)
    if (!pin) throw new Error(`missing sha256 pin for Whisper floor file ${rel}`)
    await downloadTo(`${HF_BASE}/${rel}`, dest, undefined, pin)
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
    const message = /reinstall/i.test(error) ? ASR_ASSETS_MISSING : bundleFailureUserMessage(error) || ASR_ASSETS_MISSING
    publish({ status: 'error', progress: state.progress, label: message, error: message }, onProgress)
    mainLog.warn('[asr-assets] ensure failed:', message)
    throw new Error(message)
  }
}
