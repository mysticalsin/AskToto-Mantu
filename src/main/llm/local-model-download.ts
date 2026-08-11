import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { auditLog } from '../logger'
import { getModel, modelPaths, type LocalModelFile } from './local-models'

/**
 * First-run downloader for the Métis Local weights.
 *
 * The weights used to ship inside the installer. They no longer do: at ~728 MB they dominated the
 * download, and a universal (Intel + Apple Silicon) package carrying them would exceed GitHub's 2 GB
 * per-asset release limit. So the app fetches them once, into the writable per-user model directory.
 *
 * This is the ONLY place installed application code reaches the network for model weights, and the
 * integrity rules here are what replace the build-time supply-chain gate that bundling gave us:
 *
 *   - the URL is an immutable upstream revision (commit hash in the path), never a branch;
 *   - Content-Length must equal the pinned byte count BEFORE a single byte is written;
 *   - the finished file must match the pinned SHA-256, or it is deleted rather than kept;
 *   - bytes land in a `.partial` file and are renamed into place only after that check passes, so a
 *     half-written or tampered file can never be mistaken for a usable model by a later run.
 *
 * Failure is non-fatal by design. Métis Local is one route among several — a machine that is offline,
 * behind a proxy, or short on disk simply keeps using the cloud/CLI routes, and the next launch
 * retries. Nothing here is allowed to block or crash app startup.
 */

const REQUEST_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 120_000
const MAX_ATTEMPTS = 3

export interface DownloadProgress {
  modelId: string
  /** 0..1 across BOTH files, weighted by their pinned byte counts. */
  progress: number
  receivedBytes: number
  totalBytes: number
}

type ProgressListener = (p: DownloadProgress) => void

let inFlight: Promise<boolean> | null = null

function openResponse(url: string, redirectsLeft = 5): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = httpsGet(url, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft <= 0) {
          reject(new Error(`too many redirects for ${url}`))
          return
        }
        // Hugging Face 302s the actual bytes to a CDN host.
        openResponse(new URL(res.headers.location, url).toString(), redirectsLeft - 1).then(resolve, reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`HTTP ${status} for ${url}`))
        return
      }
      resolve(res)
    })
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`request timeout for ${url}`)))
    req.on('error', reject)
  })
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

/** True when `path` already exists with the pinned size AND hash. */
async function alreadyValid(path: string, spec: LocalModelFile): Promise<boolean> {
  try {
    if (statSync(path).size !== spec.bytes) return false
  } catch {
    return false
  }
  return (await sha256Of(path)) === spec.sha256
}

async function downloadOne(
  modelId: string,
  file: 'gguf' | 'mmproj',
  spec: LocalModelFile,
  dest: string,
  onChunk: (bytes: number) => void
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const partial = `${dest}.partial`
  rmSync(partial, { force: true })

  const res = await openResponse(spec.url)

  // Reject on the declared length before writing anything: a redirect to a login/error page or a
  // swapped asset is caught here rather than after streaming half a gigabyte to disk.
  const declared = Number(res.headers['content-length'])
  if (Number.isFinite(declared) && declared !== spec.bytes) {
    res.destroy()
    throw new Error(`${file}: server declared ${declared} bytes, expected ${spec.bytes}`)
  }

  res.setTimeout(IDLE_TIMEOUT_MS, () => res.destroy(new Error(`${file}: stalled mid-download`)))
  res.on('data', (chunk: Buffer) => onChunk(chunk.length))

  try {
    await pipeline(res, createWriteStream(partial))
    const size = statSync(partial).size
    if (size !== spec.bytes) throw new Error(`${file}: got ${size} bytes, expected ${spec.bytes}`)
    const digest = await sha256Of(partial)
    if (digest !== spec.sha256) {
      throw new Error(`${file}: sha256 ${digest.slice(0, 12)}… does not match the pinned ${spec.sha256.slice(0, 12)}…`)
    }
    // Only now is the file allowed to exist under its real name.
    renameSync(partial, dest)
  } catch (err) {
    rmSync(partial, { force: true })
    throw err
  }
}

/**
 * Ensure both weight files are present and valid, downloading them if not.
 * Resolves true when the model is ready. Never throws — callers treat false as "Local unavailable".
 * Concurrent calls share one download rather than racing for the same files.
 */
export function ensureLocalModel(modelId: string, onProgress?: ProgressListener): Promise<boolean> {
  if (inFlight) return inFlight
  inFlight = run(modelId, onProgress).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(modelId: string, onProgress?: ProgressListener): Promise<boolean> {
  let entry
  try {
    entry = getModel(modelId)
  } catch {
    return false
  }
  const paths = modelPaths(modelId)
  const files = [
    { key: 'gguf' as const, spec: entry.gguf, dest: paths.gguf },
    { key: 'mmproj' as const, spec: entry.mmproj, dest: paths.mmproj }
  ]

  const totalBytes = files.reduce((sum, f) => sum + f.spec.bytes, 0)
  let received = 0
  const emit = (): void => {
    onProgress?.({ modelId, progress: totalBytes ? Math.min(1, received / totalBytes) : 0, receivedBytes: received, totalBytes })
  }

  const missing = []
  for (const f of files) {
    if (await alreadyValid(f.dest, f.spec)) received += f.spec.bytes
    else missing.push(f)
  }
  emit()
  if (!missing.length) return true

  auditLog('local.model.download_start', { modelId, files: missing.map((f) => f.key) })

  for (const f of missing) {
    // A stale file that failed verification must go before we refetch, so a crash between the two
    // never leaves a bad file sitting where a later run would trust its presence.
    rmSync(f.dest, { force: true })
    const base = received
    let lastErr: unknown
    let ok = false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !ok; attempt++) {
      try {
        received = base
        await downloadOne(modelId, f.key, f.spec, f.dest, (n) => {
          received += n
          emit()
        })
        ok = true
      } catch (err) {
        lastErr = err
        received = base
        emit()
      }
    }
    if (!ok) {
      auditLog('local.model.download_fail', {
        modelId,
        file: f.key,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr)
      })
      return false
    }
  }

  auditLog('local.model.download_ok', { modelId })
  return true
}

/** True when neither weight file is on disk yet — used to decide whether to announce the download. */
export function isLocalModelMissing(modelId: string): boolean {
  try {
    const paths = modelPaths(modelId)
    return !existsSync(paths.gguf) || !existsSync(paths.mmproj)
  } catch {
    return true
  }
}
