/**
 * Ensure Parakeet + the Whisper floor exist on a runnable Métis.
 *
 * Installed builds use only their reviewed bundled resources. Development can
 * fetch reviewed files into userData/asr-models when its local resources have
 * not yet been provisioned.
 */
import { app, net } from 'electron'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
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
import { extractParakeetArchiveWindows } from './parakeet-extract'
import { asrManifestComplete } from './asr-manifest'
import { asrMetadataStatusReady, parakeetMetadataStatusReady } from './asr-metadata-readiness'
import { getSettings } from './store'
import {
  PARAKEET_TDT_V3_INT8,
  WHISPER_BASE_Q8,
  readSpeechPackProfile,
  resolveSpeechPack,
  legacyRuntimeClosureAvailable,
  type SpeechPackComponentId,
  type SpeechPackReadiness
} from './features/components'

const execFileAsync = promisify(execFile)

export const PARAKEET_MODEL_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
export const PARAKEET_REQUIRED_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt'
] as const
export const PARAKEET_ARCHIVE_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${PARAKEET_MODEL_NAME}.tar.bz2`

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
const MAX_REDIRECTS = 8

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

export const ASR_ASSETS_MISSING = 'Could not get the transcription files. Check your connection and try again.'
export const ASR_PACKAGED_ASSETS_MISSING =
  'This Métis installation is missing its built-in transcription files. Repair or reinstall the official Métis package.'
export const ASR_SPEECH_PACK_MISSING = 'Download the selected on-device speech pack in Settings to use it.'
export const ASR_SPEECH_PROFILE_INVALID =
  'This Métis installation has an invalid speech-pack profile. Repair or reinstall the official package.'

export class AsrSpeechPackNotReadyError extends Error {
  readonly code = 'ASR_SPEECH_PACK_NOT_READY'
  constructor(readonly reason: 'lean-pack-not-installed' | 'invalid-profile') {
    super(reason === 'invalid-profile' ? ASR_SPEECH_PROFILE_INVALID : ASR_SPEECH_PACK_MISSING)
    this.name = 'AsrSpeechPackNotReadyError'
  }
}

export interface AsrAssetsProgress {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  progress: number
  label: string
  error?: string
  reason?: 'lean-pack-not-installed' | 'invalid-profile'
}

type AsrProgressReporter = (pct: number, label?: string) => void

export interface AsrEnsureTestHooks {
  fetchParakeet?: (destDir: string, onProgress?: AsrProgressReporter) => Promise<void>
  fetchWhisperFloor?: (destDir: string, onProgress?: AsrProgressReporter) => Promise<void>
  /** Test-only isolation for a development checkout whose real resources may be provisioned. */
  bundledResourceRoot?: () => string
  selectedAsrEngine?: () => 'whisper' | 'parakeet' | 'apple'
}

interface ParakeetEnsureOperation {
  promise: Promise<void>
  progress: { pct: number; label?: string }
  reporters: Set<AsrProgressReporter>
}

interface WhisperEnsureOperation {
  promise: Promise<void>
  progress: { pct: number; label?: string }
  reporters: Set<AsrProgressReporter>
}

let testHooks: AsrEnsureTestHooks | null = null
let inFlight: Promise<void> | null = null
let parakeetInFlight: ParakeetEnsureOperation | null = null
let whisperInFlight: WhisperEnsureOperation | null = null
let state: AsrAssetsProgress = { status: 'idle', progress: 0, label: '' }

export function setAsrEnsureTestHooks(hooks: AsrEnsureTestHooks | null): void {
  testHooks = hooks
}

export function resetAsrEnsureStateForTests(): void {
  inFlight = null
  parakeetInFlight = null
  whisperInFlight = null
  state = { status: 'idle', progress: 0, label: '' }
}

export function asrAssetsProgress(): AsrAssetsProgress {
  return state
}

export function bundledResourceRoot(): string {
  if (testHooks?.bundledResourceRoot) return testHooks.bundledResourceRoot()
  const repo = join(__dirname, '..', '..')
  return app.isPackaged ? process.resourcesPath : join(repo, 'resources')
}

export function speechPackBuildProfile(): ReturnType<typeof readSpeechPackProfile> {
  return readSpeechPackProfile(bundledResourceRoot(), app.isPackaged)
}

export function selectedAsrEngine(): 'whisper' | 'parakeet' | 'apple' {
  return testHooks?.selectedAsrEngine?.() ?? getSettings().asrEngine
}

export function userDataSpeechPackRoot(): string {
  return join(app.getPath('userData'), 'speech-packs')
}

export async function resolveSelectedSpeechPack(engine = selectedAsrEngine()): Promise<{
  componentId: SpeechPackComponentId | null
  readiness: SpeechPackReadiness | null
  path: string | null
}> {
  if (selectedAsrEngine() !== engine) return { componentId: null, readiness: null, path: null }
  const component = engine === 'whisper' ? WHISPER_BASE_Q8 : engine === 'parakeet' ? PARAKEET_TDT_V3_INT8 : null
  if (!component) return { componentId: null, readiness: null, path: null }
  const root = userDataSpeechPackRoot()
  const readiness = await resolveSpeechPack(root, component)
  if (selectedAsrEngine() !== engine) return { componentId: null, readiness: null, path: null }
  return {
    componentId: component.id,
    readiness,
    path: readiness.status === 'ready' ? join(root, component.id, component.version) : null
  }
}

async function requireLeanSpeechPack(
  engine: 'whisper' | 'parakeet',
  profile: Awaited<ReturnType<typeof speechPackBuildProfile>>
): Promise<string> {
  if (profile.profile === null) throw new AsrSpeechPackNotReadyError('invalid-profile')
  if (profile.profile !== 'lean' || selectedAsrEngine() !== engine) {
    throw new AsrSpeechPackNotReadyError('lean-pack-not-installed')
  }
  const pack = await resolveSelectedSpeechPack(engine)
  if (selectedAsrEngine() !== engine || pack.readiness?.status !== 'ready' || !pack.path) {
    throw new AsrSpeechPackNotReadyError('lean-pack-not-installed')
  }
  return pack.path
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

async function parakeetFilesReadyForProfile(
  dir: string,
  profile: Awaited<ReturnType<typeof speechPackBuildProfile>>
): Promise<boolean> {
  if (profile.profile === null) return false
  if (profile.profile === 'lean')
    return (
      selectedAsrEngine() === 'parakeet' && (await resolveSelectedSpeechPack('parakeet')).readiness?.status === 'ready'
    )
  return PARAKEET_REQUIRED_FILES.every((name) => filePresent(join(dir, name)))
}

export async function parakeetFilesReady(dir: string): Promise<boolean> {
  return parakeetFilesReadyForProfile(dir, await speechPackBuildProfile())
}

async function whisperFloorReadyForProfile(
  modelsRoot: string,
  profile: Awaited<ReturnType<typeof speechPackBuildProfile>>
): Promise<boolean> {
  if (profile.profile === null) return false
  if (profile.profile === 'lean')
    return (
      selectedAsrEngine() === 'whisper' && (await resolveSelectedSpeechPack('whisper')).readiness?.status === 'ready'
    )
  const dir = join(modelsRoot, ...WHISPER_FLOOR_ID.split('/'))
  return WHISPER_FLOOR_REQUIRED_FILES.every((name) => filePresent(join(dir, name)))
}

export async function whisperFloorReady(modelsRoot: string): Promise<boolean> {
  return whisperFloorReadyForProfile(modelsRoot, await speechPackBuildProfile())
}

export function parakeetBundledDir(): string {
  return join(bundledResourceRoot(), 'asr', PARAKEET_MODEL_NAME)
}

export function parakeetUserDir(): string {
  return join(userDataAsrRoot(), PARAKEET_MODEL_NAME)
}

/** Installed builds never use a userData copy to mask a damaged bundled payload. */
async function resolveParakeetDirForProfile(
  profile: Awaited<ReturnType<typeof speechPackBuildProfile>>
): Promise<string> {
  if (profile.profile === null) throw new AsrSpeechPackNotReadyError('invalid-profile')
  if (profile.profile === 'lean') return requireLeanSpeechPack('parakeet', profile)
  const bundled = parakeetBundledDir()
  if (app.isPackaged || (await parakeetFilesReadyForProfile(bundled, profile))) return bundled
  if (await parakeetFilesReadyForProfile(parakeetUserDir(), profile)) return parakeetUserDir()
  return bundled
}

export async function resolveParakeetDir(): Promise<string> {
  return resolveParakeetDirForProfile(await speechPackBuildProfile())
}

/** Cheap status probe: checks metadata only and never opens model weights. */
export async function parakeetModelMetadataReady(): Promise<boolean> {
  const profile = await speechPackBuildProfile()
  return parakeetMetadataStatusReady(asrMetadataOptions(profile))
}

/** Installed builds never use a userData copy to mask a damaged bundled payload. */
async function resolveWhisperModelsRootForProfile(
  profile: Awaited<ReturnType<typeof speechPackBuildProfile>>
): Promise<string> {
  if (profile.profile === null) throw new AsrSpeechPackNotReadyError('invalid-profile')
  if (profile.profile === 'lean') return requireLeanSpeechPack('whisper', profile)
  const bundled = join(bundledResourceRoot(), 'models')
  if (app.isPackaged || (await whisperFloorReadyForProfile(bundled, profile))) return bundled
  if (await whisperFloorReadyForProfile(userDataAsrRoot(), profile)) return userDataAsrRoot()
  return bundled
}

export async function resolveWhisperModelsRoot(): Promise<string> {
  return resolveWhisperModelsRootForProfile(await speechPackBuildProfile())
}

/** Protocol adapter for main/index: lean is strict even before the selected pack exists. */
export async function asrModelProtocolSpeechPackOptions(): Promise<{
  useOnlySpeechPackModels: boolean
  speechPackModelsRoot?: string
}> {
  const profile = await speechPackBuildProfile()
  if (!(await legacyRuntimeClosureAvailable())) return { useOnlySpeechPackModels: true }
  if (profile.profile === 'full' || profile.profile === 'development') return { useOnlySpeechPackModels: false }
  if (profile.profile === null) return { useOnlySpeechPackModels: true }
  const selected = selectedAsrEngine()
  if (selected !== 'whisper') return { useOnlySpeechPackModels: true }
  const pack = await resolveSelectedSpeechPack('whisper')
  return {
    useOnlySpeechPackModels: true,
    ...(pack.readiness?.status === 'ready' && pack.path ? { speechPackModelsRoot: pack.path } : {})
  }
}

async function importAsrAssetsReadyForProfile(
  profile: Awaited<ReturnType<typeof speechPackBuildProfile>>
): Promise<boolean> {
  if (profile.profile === null) return false
  if (profile.profile === 'lean') {
    const engine = selectedAsrEngine()
    if (engine === 'apple') return true
    return (await resolveSelectedSpeechPack(engine)).readiness?.status === 'ready'
  }
  if (app.isPackaged) {
    return (
      (await parakeetFilesReadyForProfile(parakeetBundledDir(), profile)) && asrManifestComplete(bundledResourceRoot())
    )
  }
  const parakeetDir = await resolveParakeetDirForProfile(profile)
  const whisperRoot = await resolveWhisperModelsRootForProfile(profile)
  return (
    (await parakeetFilesReadyForProfile(parakeetDir, profile)) &&
    (await whisperFloorReadyForProfile(whisperRoot, profile))
  )
}

export async function importAsrAssetsReady(): Promise<boolean> {
  const profile = await speechPackBuildProfile()
  if (profile.profile === 'lean' && !(await legacyRuntimeClosureAvailable())) return false
  return asrMetadataStatusReady(asrMetadataOptions(profile))
}

function asrMetadataOptions(
  profile: Awaited<ReturnType<typeof speechPackBuildProfile>>
): Parameters<typeof asrMetadataStatusReady>[0] {
  const resourceRoot = bundledResourceRoot()
  return {
    profile,
    packaged: app.isPackaged,
    selectedEngine: selectedAsrEngine(),
    bundledRoot: resourceRoot,
    bundledParakeetDir: parakeetBundledDir(),
    userDataParakeetDir: parakeetUserDir(),
    bundledModelsRoot: join(resourceRoot, 'models'),
    userDataModelsRoot: userDataAsrRoot(),
    parakeetFiles: PARAKEET_REQUIRED_FILES,
    whisperFloorId: WHISPER_FLOOR_ID,
    whisperFloorFiles: WHISPER_FLOOR_REQUIRED_FILES,
    manifestComplete: asrManifestComplete,
    resolveLeanComponent: async (engine) => (await resolveSelectedSpeechPack(engine)).readiness?.status === 'ready'
  }
}

/** Renderer-safe snapshot. An installed app must report a missing bundled payload explicitly. */
export async function asrAssetsStatusSnapshot(): Promise<AsrAssetsProgress & { ready: boolean }> {
  const profile = await speechPackBuildProfile()
  if (profile.profile === null) {
    return {
      ready: false,
      status: 'error',
      progress: 0,
      label: ASR_SPEECH_PROFILE_INVALID,
      error: ASR_SPEECH_PROFILE_INVALID,
      reason: 'invalid-profile'
    }
  }
  const runtimeReady = await legacyRuntimeClosureAvailable()
  const ready = runtimeReady && (await asrMetadataStatusReady(asrMetadataOptions(profile)))
  if (profile.profile === 'lean' && !ready) {
    return {
      ready: false,
      status: 'error',
      progress: 0,
      label: ASR_SPEECH_PACK_MISSING,
      error: ASR_SPEECH_PACK_MISSING,
      reason: 'lean-pack-not-installed'
    }
  }
  if (ready) {
    return { ready: true, status: 'ready', progress: 1, label: 'Transcription files ready' }
  }
  if (app.isPackaged) {
    return {
      ready: false,
      status: 'error',
      progress: 0,
      label: ASR_PACKAGED_ASSETS_MISSING,
      error: ASR_PACKAGED_ASSETS_MISSING
    }
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

function publish(next: AsrAssetsProgress, onProgress?: AsrProgressReporter): void {
  state = next
  if (next.status === 'downloading' || next.status === 'ready')
    onProgress?.(Math.round(next.progress * 100), next.label)
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

const EXTRACTION_TIMEOUT_MS = 10 * 60_000

async function extractTarBz2(archive: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  if (process.platform === 'win32') {
    await extractParakeetArchiveWindows(archive, destDir)
    return
  }
  await execFileAsync('tar', ['xjf', archive, '-C', destDir], { timeout: EXTRACTION_TIMEOUT_MS })
}

async function fetchParakeetToUserData(onProgress?: AsrProgressReporter): Promise<void> {
  const destDir = parakeetUserDir()
  if (await parakeetFilesReady(destDir)) return
  if (testHooks?.fetchParakeet) {
    await testHooks.fetchParakeet(destDir, onProgress)
    if (!(await parakeetFilesReady(destDir))) throw new Error(ASR_ASSETS_MISSING)
    return
  }

  mkdirSync(userDataAsrRoot(), { recursive: true })
  const archive = join(userDataAsrRoot(), `${PARAKEET_MODEL_NAME}.tar.bz2`)
  const stagingRoot = join(userDataAsrRoot(), `.${PARAKEET_MODEL_NAME}.extracting`)
  const stagedModelDir = join(stagingRoot, PARAKEET_MODEL_NAME)
  publish({ status: 'downloading', progress: 0.02, label: 'Getting transcription files…' }, onProgress)
  await downloadTo(PARAKEET_ARCHIVE_URL, archive, (got, total) => {
    const frac = total ? Math.min(0.9, got / total) : 0.3
    publish({ status: 'downloading', progress: frac, label: 'Getting transcription files…' }, onProgress)
  })
  publish({ status: 'downloading', progress: 0.92, label: 'Preparing transcription files…' }, onProgress)
  rmSync(stagingRoot, { recursive: true, force: true })
  try {
    await extractTarBz2(archive, stagingRoot)
    if (!(await parakeetFilesReady(stagedModelDir))) throw new Error(ASR_ASSETS_MISSING)
    // Only replace the incomplete fallback after the complete staged model passes the same readiness
    // predicate as the live engine. A stalled/corrupt archive can never become a half-ready model.
    rmSync(destDir, { recursive: true, force: true })
    renameSync(stagedModelDir, destDir)
    rmSync(archive, { force: true })
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true })
  }
  if (!(await parakeetFilesReady(destDir))) throw new Error(ASR_ASSETS_MISSING)
}

async function fetchWhisperFloorToUserData(onProgress?: AsrProgressReporter): Promise<void> {
  const destRoot = userDataAsrRoot()
  if (await whisperFloorReady(destRoot)) return
  if (testHooks?.fetchWhisperFloor) {
    await testHooks.fetchWhisperFloor(destRoot, onProgress)
    if (!(await whisperFloorReady(destRoot))) throw new Error(ASR_ASSETS_MISSING)
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
      publish({ status: 'downloading', progress: done / total, label: 'Getting transcription files…' }, onProgress)
      continue
    }
    await downloadTo(`${HF_BASE}/${rel}`, dest, (got, bytes) => {
      const fraction = bytes > 0 ? Math.min(1, got / bytes) : 0
      publish(
        {
          status: 'downloading',
          progress: (done + fraction) / total,
          label: `Getting transcription files… (${done + 1}/${total})`
        },
        onProgress
      )
    })
    done += 1
    publish({ status: 'downloading', progress: done / total, label: 'Getting transcription files…' }, onProgress)
  }
  if (!(await whisperFloorReady(destRoot))) throw new Error(ASR_ASSETS_MISSING)
}

function reportParakeetEnsure(operation: ParakeetEnsureOperation, pct: number, label?: string): void {
  operation.progress = { pct, label }
  for (const reporter of operation.reporters) reporter(pct, label)
}

function observeParakeetEnsure(operation: ParakeetEnsureOperation, onProgress?: AsrProgressReporter): Promise<void> {
  if (!onProgress) return operation.promise
  operation.reporters.add(onProgress)
  onProgress(operation.progress.pct, operation.progress.label)
  return operation.promise.finally(() => operation.reporters.delete(onProgress))
}

async function runParakeetEnsure(operation: ParakeetEnsureOperation, onProgress?: AsrProgressReporter): Promise<void> {
  const profile = await speechPackBuildProfile()
  if (profile.profile === null) throw new AsrSpeechPackNotReadyError('invalid-profile')
  if (profile.profile === 'lean') {
    if (
      selectedAsrEngine() !== 'parakeet' ||
      (await resolveSelectedSpeechPack('parakeet')).readiness?.status !== 'ready'
    ) {
      throw new AsrSpeechPackNotReadyError('lean-pack-not-installed')
    }
    onProgress?.(100)
    return
  }
  if (await parakeetFilesReadyForProfile(parakeetBundledDir(), profile)) {
    onProgress?.(100)
    return
  }
  if (app.isPackaged) throw new Error(ASR_PACKAGED_ASSETS_MISSING)
  if (await parakeetFilesReadyForProfile(parakeetUserDir(), profile)) {
    onProgress?.(100)
    return
  }
  await fetchParakeetToUserData((pct, label) => reportParakeetEnsure(operation, pct, label))
}

export function ensureParakeetAssets(onProgress?: AsrProgressReporter): Promise<void> {
  if (!parakeetInFlight) {
    let resolveOperation!: () => void
    let rejectOperation!: (error: unknown) => void
    const operation: ParakeetEnsureOperation = {
      promise: new Promise<void>((resolve, reject) => {
        resolveOperation = resolve
        rejectOperation = reject
      }),
      progress: { pct: 0 },
      reporters: new Set()
    }
    parakeetInFlight = operation
    const observed = observeParakeetEnsure(operation, onProgress)
    void runParakeetEnsure(operation, onProgress)
      .then(() => {
        reportParakeetEnsure(operation, 100)
        resolveOperation()
      }, rejectOperation)
      .finally(() => {
        if (parakeetInFlight === operation) parakeetInFlight = null
      })
    return observed
  }
  return observeParakeetEnsure(parakeetInFlight, onProgress)
}

function reportWhisperEnsure(operation: WhisperEnsureOperation, pct: number, label?: string): void {
  operation.progress = { pct, label }
  for (const reporter of operation.reporters) reporter(pct, label)
}

function observeWhisperEnsure(operation: WhisperEnsureOperation, onProgress?: AsrProgressReporter): Promise<void> {
  if (!onProgress) return operation.promise
  operation.reporters.add(onProgress)
  onProgress(operation.progress.pct, operation.progress.label)
  return operation.promise.finally(() => operation.reporters.delete(onProgress))
}

async function runWhisperEnsure(operation: WhisperEnsureOperation): Promise<void> {
  const profile = await speechPackBuildProfile()
  if (profile.profile === null) throw new AsrSpeechPackNotReadyError('invalid-profile')
  if (profile.profile === 'lean') {
    if (
      selectedAsrEngine() !== 'whisper' ||
      (await resolveSelectedSpeechPack('whisper')).readiness?.status !== 'ready'
    ) {
      throw new AsrSpeechPackNotReadyError('lean-pack-not-installed')
    }
    reportWhisperEnsure(operation, 100)
    return
  }
  const bundled = join(bundledResourceRoot(), 'models')
  if (await whisperFloorReadyForProfile(bundled, profile)) {
    reportWhisperEnsure(operation, 100)
    return
  }
  if (app.isPackaged) throw new Error(ASR_PACKAGED_ASSETS_MISSING)
  if (await whisperFloorReadyForProfile(userDataAsrRoot(), profile)) {
    reportWhisperEnsure(operation, 100)
    return
  }
  await fetchWhisperFloorToUserData((pct, label) => reportWhisperEnsure(operation, pct, label))
}

export function ensureWhisperFloorAssets(onProgress?: AsrProgressReporter): Promise<void> {
  if (!whisperInFlight) {
    let resolveOperation!: () => void
    let rejectOperation!: (error: unknown) => void
    const operation: WhisperEnsureOperation = {
      promise: new Promise<void>((resolve, reject) => {
        resolveOperation = resolve
        rejectOperation = reject
      }),
      progress: { pct: 0 },
      reporters: new Set()
    }
    whisperInFlight = operation
    const observed = observeWhisperEnsure(operation, onProgress)
    void runWhisperEnsure(operation)
      .then(() => {
        reportWhisperEnsure(operation, 100)
        resolveOperation()
      }, rejectOperation)
      .finally(() => {
        if (whisperInFlight === operation) whisperInFlight = null
      })
    return observed
  }
  return observeWhisperEnsure(whisperInFlight, onProgress)
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
  const profile = await speechPackBuildProfile()
  if (profile.profile === null) throw new AsrSpeechPackNotReadyError('invalid-profile')
  if (profile.profile === 'lean') {
    if (!(await importAsrAssetsReadyForProfile(profile)))
      throw new AsrSpeechPackNotReadyError('lean-pack-not-installed')
    publish({ status: 'ready', progress: 1, label: 'Transcription files ready' }, onProgress)
    return
  }
  const initiallyReady = await importAsrAssetsReadyForProfile(profile)
  if (app.isPackaged && !initiallyReady) throw new Error(ASR_PACKAGED_ASSETS_MISSING)
  if (initiallyReady) {
    publish({ status: 'ready', progress: 1, label: 'Transcription files ready' }, onProgress)
    return
  }
  try {
    publish({ status: 'downloading', progress: 0, label: 'Getting transcription files…' }, onProgress)
    await ensureParakeetAssets((pct, label) => {
      publish(
        { status: 'downloading', progress: (pct / 100) * 0.75, label: label || 'Getting transcription files…' },
        onProgress
      )
    })
    await ensureWhisperFloorAssets((pct, label) => {
      publish(
        { status: 'downloading', progress: 0.75 + (pct / 100) * 0.25, label: label || 'Getting transcription files…' },
        onProgress
      )
    })
    if (!(await importAsrAssetsReadyForProfile(await speechPackBuildProfile()))) throw new Error(ASR_ASSETS_MISSING)
    publish({ status: 'ready', progress: 1, label: 'Transcription files ready' }, onProgress)
    mainLog.info('[asr-assets] Parakeet and Whisper floor ready')
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const message =
      error === ASR_PACKAGED_ASSETS_MISSING ? error : bundleFailureUserMessage(error) || ASR_ASSETS_MISSING
    publish({ status: 'error', progress: state.progress, label: message, error: message }, onProgress)
    mainLog.warn('[asr-assets] ensure failed:', message)
    throw new Error(message)
  }
}
