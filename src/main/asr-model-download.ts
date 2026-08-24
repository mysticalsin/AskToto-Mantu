/**
 * asr-model-download.ts — fetch the high-accuracy transcription model on demand (MQA-247).
 *
 * Deliberately the same shape as llm/local-model-download.ts, which solved the identical problem for the
 * LLM weights (MQA-146): an asset too large to ship, fetched once per user profile, size- and SHA-256-
 * pinned, verified before anything is allowed to use it. Where that module handles two files this one
 * handles a directory, which is the only real difference — so the ordering guarantees below are the ones
 * that matter, and they are the same ones.
 *
 * ORDERING, AND WHY IT IS NOT ARBITRARY
 *
 *   1. Disk is checked for the WHOLE transfer before a single byte is written. Not per-file: seven files
 *      that each fit individually can still fill a volume between them, and filling a startup volume does
 *      not fail politely — Chromium CHECK()s and aborts, and Crashpad dies the same way, so the user sees
 *      an app that vanishes with no dialog and no log (observed 2026-08-24, and the reason 14e4e6d exists).
 *   2. Every file lands as `.partial` and is renamed only after BOTH its byte length and its SHA-256
 *      match. A half-written ONNX blob under its real name would be indistinguishable from a good one.
 *   3. `isHighTierAsrModelReady` re-verifies hashes, so a truncated or tampered file can never be adopted
 *      by a later run just because the path exists.
 *
 * WHY IT IS OPT-IN
 *
 * 1.61 GB is not a thing to start behind someone's back on a metered connection, and the floor model does
 * work — badly on non-English audio, which is exactly what the Settings copy says. So nothing here runs
 * automatically: the user asks for it. That also means the failure mode of this module is "the import is
 * transcribed by the floor model, as before", never "the app is worse than it was".
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { app, net } from 'electron'
import { mainLog } from './logger'
import { HIGH_TIER_ASR_MODEL, asrModelBytes, asrModelFileUrl, type AsrModelFile, type AsrModelSpec } from './asr-model-manifest'

/** Same headroom rule and rationale as the LLM downloader — see assertRoomFor there. */
const DISK_HEADROOM_BYTES = 512 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 120_000

export interface AsrModelDownloadState {
  status: 'idle' | 'downloading' | 'ready' | 'error'
  /** 0..1 across the whole model, not per file. */
  progress: number
  error?: string
}

const IDLE: AsrModelDownloadState = { status: 'idle', progress: 0 }
let state: AsrModelDownloadState = IDLE
let inFlight: Promise<boolean> | null = null

export function asrModelDownloadState(): AsrModelDownloadState {
  return state
}

/**
 * Where fetched ASR models live: the per-user profile, NOT the read-only packaged resources. Same split
 * the LLM weights use, and the reason is the same — an installed app's resources directory is not
 * writable on either platform, and a per-user copy survives reinstalling the app.
 */
export function asrModelRoot(): string {
  return join(app.getPath('userData'), 'asr-models')
}

export function asrModelDir(spec: AsrModelSpec = HIGH_TIER_ASR_MODEL): string {
  return join(asrModelRoot(), ...spec.id.split('/'))
}

function sha256Of(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function fileIsValid(path: string, spec: AsrModelFile): Promise<boolean> {
  try {
    if (statSync(path).size !== spec.bytes) return false
  } catch {
    return false
  }
  return (await sha256Of(path)) === spec.sha256
}

/**
 * Every pinned file present with the right length AND digest. Re-hashing on every call is deliberate: the
 * cost is paid once per host start, and the alternative — trusting a path to mean a good file — is how a
 * truncated download gets adopted silently.
 */
export async function isHighTierAsrModelReady(spec: AsrModelSpec = HIGH_TIER_ASR_MODEL): Promise<boolean> {
  const dir = asrModelDir(spec)
  for (const file of spec.files) {
    if (!(await fileIsValid(join(dir, ...file.path.split('/')), file))) return false
  }
  return true
}

/** Refuse a transfer the volume cannot hold, before the network is touched. Unmeasurable != insufficient. */
function assertRoomForAll(bytes: number, dir: string): void {
  let freeBytes: number
  try {
    const fs = statfsSync(dir)
    freeBytes = fs.bavail * fs.bsize
  } catch {
    return
  }
  const needed = bytes + DISK_HEADROOM_BYTES
  if (freeBytes >= needed) return
  const gb = (n: number): string => `${(n / 1e9).toFixed(1)} GB`
  throw new Error(
    `Not enough free disk space for the high-accuracy transcription model — needs ${gb(needed)} ` +
      `(${gb(bytes)} of model files plus ${gb(DISK_HEADROOM_BYTES)} of headroom) but only ` +
      `${gb(freeBytes)} is available. Free up space and try again.`
  )
}

async function downloadOne(spec: AsrModelSpec, file: AsrModelFile, dest: string, onChunk: (n: number) => void): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  rmSync(partial, { force: true })

  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number, why: string): void => {
    clearTimeout(timer)
    timer = setTimeout(() => ctrl.abort(new Error(why)), ms)
  }
  arm(REQUEST_TIMEOUT_MS, `${file.path}: request timeout`)

  try {
    const url = asrModelFileUrl(spec, file)
    const res = await net.fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`${file.path}: HTTP ${res.status}`)
    // Catch a redirect to a login/error page on the declared length rather than after streaming a
    // gigabyte to disk. A missing content-length is not fatal — the post-write checks still bind.
    const header = res.headers.get('content-length')
    const declared = header === null ? Number.NaN : Number(header)
    if (Number.isFinite(declared) && declared !== file.bytes) {
      throw new Error(`${file.path}: server declared ${declared} bytes, expected ${file.bytes}`)
    }
    if (!res.body) throw new Error(`${file.path}: response carried no body`)

    const reader = res.body.getReader()
    arm(IDLE_TIMEOUT_MS, `${file.path}: stalled mid-download`)
    await pipeline(
      (async function* () {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          if (!value) continue
          arm(IDLE_TIMEOUT_MS, `${file.path}: stalled mid-download`)
          onChunk(value.byteLength)
          yield value
        }
      })(),
      createWriteStream(partial)
    )

    const size = statSync(partial).size
    if (size !== file.bytes) throw new Error(`${file.path}: got ${size} bytes, expected ${file.bytes}`)
    const digest = await sha256Of(partial)
    if (digest !== file.sha256) {
      throw new Error(`${file.path}: sha256 ${digest.slice(0, 12)}… does not match the pinned ${file.sha256.slice(0, 12)}…`)
    }
    // Only now may it exist under its real name.
    renameSync(partial, dest)
  } catch (err) {
    ctrl.abort()
    rmSync(partial, { force: true })
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch the model if it is not already valid on disk. Resolves true when it is ready to load.
 * Never throws — a failure leaves the floor model in charge, exactly as before the fetch was offered.
 * Concurrent callers share one transfer rather than racing for the same files.
 */
export function ensureHighTierAsrModel(spec: AsrModelSpec = HIGH_TIER_ASR_MODEL): Promise<boolean> {
  if (inFlight) return inFlight
  inFlight = run(spec).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(spec: AsrModelSpec): Promise<boolean> {
  if (await isHighTierAsrModelReady(spec)) {
    state = { status: 'ready', progress: 1 }
    return true
  }
  const dir = asrModelDir(spec)
  const total = asrModelBytes(spec)
  try {
    mkdirSync(dir, { recursive: true })
    // The WHOLE transfer, before any of it starts. Per-file would pass seven times and still fill the disk.
    assertRoomForAll(total, dir)
  } catch (e) {
    state = { status: 'error', progress: 0, error: e instanceof Error ? e.message : String(e) }
    mainLog.warn('[asr-model] refused:', state.error)
    return false
  }

  state = { status: 'downloading', progress: 0 }
  // Files already valid from an interrupted run are credited to progress rather than re-fetched — that is
  // what makes a resumed download resume rather than restart.
  let done = 0
  for (const file of spec.files) {
    if (await fileIsValid(join(dir, ...file.path.split('/')), file)) done += file.bytes
  }
  state = { status: 'downloading', progress: total ? done / total : 0 }

  for (const file of spec.files) {
    const dest = join(dir, ...file.path.split('/'))
    if (await fileIsValid(dest, file)) continue
    try {
      let sinceFile = 0
      await downloadOne(spec, file, dest, (n) => {
        sinceFile += n
        state = { status: 'downloading', progress: total ? Math.min(1, (done + sinceFile) / total) : 0 }
      })
      done += file.bytes
      state = { status: 'downloading', progress: total ? Math.min(1, done / total) : 0 }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      state = { status: 'error', progress: state.progress, error }
      mainLog.warn(`[asr-model] ${file.path} failed:`, error)
      return false
    }
  }

  // Belt and braces: prove the whole set before declaring it usable, rather than trusting the loop above.
  if (!(await isHighTierAsrModelReady(spec))) {
    state = { status: 'error', progress: state.progress, error: 'The downloaded model did not verify.' }
    return false
  }
  state = { status: 'ready', progress: 1 }
  mainLog.info(`[asr-model] ${spec.id} ready (${(total / 1e9).toFixed(2)} GB)`)
  return true
}

/** Remove the fetched model. Frees 1.61 GB and returns imports to the bundled floor. */
export function removeHighTierAsrModel(spec: AsrModelSpec = HIGH_TIER_ASR_MODEL): void {
  const dir = asrModelDir(spec)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  state = IDLE
}
