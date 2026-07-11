import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { totalmem } from 'node:os'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { auditLog, type AuditEvent } from '../logger'

/**
 * Métis Local model manifest + download/verify/delete manager (main process, pure — no IPC wiring here;
 * that's Rock 4). Mirrors the asr-manifest.ts pattern: a hard-coded, code-reviewed list is the only
 * source of truth for what the app will ever fetch or load.
 */

export interface LocalModelFile {
  url: string
  bytes: number
  sha256: string
}

export interface LocalModelEntry {
  id: string
  label: string
  minTotalRamGB: number
  gguf: LocalModelFile
  mmproj: LocalModelFile
}

/**
 * Manifest law (PLAN.md §4.5): a model may enter this list ONLY with a real-download-verified sha256 —
 * no placeholder or promised-later pins. v1 ships exactly the two fully-pinned models from the plan's §3
 * pins (Qwen3.5 0.8B lite + Qwen3.5 2B default, UD-Q4_K_XL quants + mmproj-F16). qwen3.5-4b is a
 * documented follow-up that enters only once its own sha256 is pinned the same way — it is NOT here.
 */
export const LOCAL_MODELS: readonly LocalModelEntry[] = [
  {
    id: 'qwen3.5-0.8b',
    label: 'Qwen3.5 0.8B — Lite',
    minTotalRamGB: 8,
    gguf: {
      url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-UD-Q4_K_XL.gguf',
      bytes: 558772480,
      sha256: '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5'
    },
    mmproj: {
      url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf',
      bytes: 204987232,
      sha256: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453'
    }
  },
  {
    id: 'qwen3.5-2b',
    label: 'Qwen3.5 2B — Default',
    minTotalRamGB: 8,
    gguf: {
      url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-UD-Q4_K_XL.gguf',
      bytes: 1339752704,
      sha256: '0af96165ea615bea39a04118d63f0b6d35908aea850ee4a51aa6151d851b8b35'
    },
    mmproj: {
      url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/mmproj-F16.gguf',
      bytes: 668227264,
      sha256: '7035e9cb8d7c6a9681d07eef9a364783e86ea4cd73faab2eabb4f43a101830c7'
    }
  }
]

function getModel(id: string): LocalModelEntry {
  const entry = LOCAL_MODELS.find((m) => m.id === id)
  if (!entry) throw new Error(`Unknown local model id: "${id}"`)
  return entry
}

// ─── Typed errors ────────────────────────────────────────────────────────────────

/** Thrown by assertRamOk()/downloadModel() when this machine doesn't meet a model's minTotalRamGB. */
export class InsufficientRamError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly requiredGB: number,
    public readonly availableGB: number,
    public readonly suggestion?: LocalModelEntry
  ) {
    const suggestText = suggestion
      ? ` Try "${suggestion.label}" instead (needs ${suggestion.minTotalRamGB} GB).`
      : ''
    super(
      `This model needs at least ${requiredGB} GB of RAM — this machine has ${availableGB.toFixed(1)} GB.${suggestText}`
    )
    this.name = 'InsufficientRamError'
  }
}

/** Thrown when a downloaded file's streamed sha256 doesn't match its manifest pin. The bad file is
 *  deleted before this throws — callers never see a corrupt file left on disk. */
export class ChecksumMismatchError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly file: 'gguf' | 'mmproj',
    public readonly expectedSha256: string,
    public readonly actualSha256: string
  ) {
    super(
      `Download corrupted for ${modelId} (${file}): checksum mismatch (expected ${expectedSha256.slice(0, 8)}…, ` +
        `got ${actualSha256.slice(0, 8)}…). Please retry the download.`
    )
    this.name = 'ChecksumMismatchError'
  }
}

/** Thrown when a download stream ends with fewer (or more) bytes than the manifest pin expects — a
 *  truncated connection would otherwise pass the byte-size check silently if only length were compared
 *  post-hoc; this fires from inside the same streaming pass that also tracks the hash. */
export class IncompleteDownloadError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly file: 'gguf' | 'mmproj',
    public readonly expectedBytes: number,
    public readonly receivedBytes: number
  ) {
    super(
      `Incomplete download for ${modelId} (${file}): got ${receivedBytes} of ${expectedBytes} bytes. Please retry.`
    )
    this.name = 'IncompleteDownloadError'
  }
}

// ─── Audit ───────────────────────────────────────────────────────────────────────
// logger.ts's AuditEvent union now names all three of this module's events directly (Rock 3) — no cast
// needed.
type LocalModelAuditEvent = Extract<AuditEvent, `local.model.${string}`>
function localAudit(event: LocalModelAuditEvent, detail: Record<string, unknown>): void {
  auditLog(event, detail)
}

// ─── RAM gate ────────────────────────────────────────────────────────────────────

function totalRamGB(): number {
  return totalmem() / 1024 ** 3
}

/** The smallest-footprint OTHER model in the manifest — named in the RAM-gate error so a refusal always
 *  offers a concrete next step instead of a dead end. Ties on minTotalRamGB break on total download size. */
function smallerModelSuggestion(excludeId: string): LocalModelEntry | undefined {
  const others = LOCAL_MODELS.filter((m) => m.id !== excludeId)
  if (others.length === 0) return undefined
  return [...others].sort(
    (a, b) =>
      a.minTotalRamGB - b.minTotalRamGB || a.gguf.bytes + a.mmproj.bytes - (b.gguf.bytes + b.mmproj.bytes)
  )[0]
}

/** Refuses download/load when this machine's total RAM is below the model's minTotalRamGB. Exported so
 *  the future load path (local-runtime.ts) can reuse the exact same gate rather than re-deriving it. */
export function assertRamOk(id: string): void {
  const entry = getModel(id)
  const available = totalRamGB()
  if (available < entry.minTotalRamGB) {
    throw new InsufficientRamError(id, entry.minTotalRamGB, available, smallerModelSuggestion(id))
  }
}

// ─── Storage paths (main-process only — never sent to the renderer) ──────────────

function modelDir(id: string): string {
  return join(app.getPath('userData'), 'local-llm', 'models', id)
}

function filePath(id: string, file: 'gguf' | 'mmproj'): string {
  return join(modelDir(id), file === 'gguf' ? 'model.gguf' : 'mmproj.gguf')
}

export interface LocalModelPaths {
  dir: string
  gguf: string
  mmproj: string
}

/** Absolute on-disk paths for a model's files. Main-process internal use only (e.g. spawning the
 *  sidecar) — never expose the return value over IPC. */
export function modelPaths(id: string): LocalModelPaths {
  getModel(id) // throws on an unknown id
  return { dir: modelDir(id), gguf: filePath(id, 'gguf'), mmproj: filePath(id, 'mmproj') }
}

function fileMatches(path: string, expectedBytes: number): boolean {
  try {
    return statSync(path).size === expectedBytes
  } catch {
    return false
  }
}

/** True only when both the gguf and mmproj files exist and their size matches the manifest pin. */
export function isDownloaded(id: string): boolean {
  const entry = getModel(id)
  const paths = modelPaths(id)
  return fileMatches(paths.gguf, entry.gguf.bytes) && fileMatches(paths.mmproj, entry.mmproj.bytes)
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
}

export function deleteModel(id: string): void {
  getModel(id) // throws on an unknown id
  rmSync(modelDir(id), { recursive: true, force: true })
  localAudit('local.model.delete', { modelId: id })
}

/** Renderer-safe metadata only — never a path, port, or key. Matches the manifest law's public surface:
 *  id, label, sizes, downloaded state, RAM requirement. */
export interface LocalModelSummary {
  id: string
  label: string
  minTotalRamGB: number
  ggufBytes: number
  mmprojBytes: number
  totalBytes: number
  downloaded: boolean
}

export function listModels(): LocalModelSummary[] {
  return LOCAL_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    minTotalRamGB: m.minTotalRamGB,
    ggufBytes: m.gguf.bytes,
    mmprojBytes: m.mmproj.bytes,
    totalBytes: m.gguf.bytes + m.mmproj.bytes,
    downloaded: isDownloaded(m.id)
  }))
}

// ─── Download ────────────────────────────────────────────────────────────────────

export interface DownloadProgress {
  modelId: string
  file: 'gguf' | 'mmproj'
  received: number
  total: number
}
export type ProgressCallback = (p: DownloadProgress) => void

/** One in-flight AbortController per model id, so cancelDownload(id) can reach the right transfer. */
const activeDownloads = new Map<string, AbortController>()

/** GET url, dispatching to node:http or node:https by scheme. Every manifest URL is a hardcoded
 *  huggingface.co https URL — the http branch only ever activates in tests against a local mock server,
 *  never in production, since we never fetch an arbitrary (non-manifest) URL. */
function rawGet(
  url: string,
  headers: Record<string, string>,
  cb: (res: IncomingMessage) => void
): ReturnType<typeof httpsGet> {
  const get = url.startsWith('https:') ? httpsGet : httpGet
  return get(url, { headers }, cb)
}

/** HTTPS GET with redirect following + optional Range resume, abortable via `signal`. Resolves with the
 *  final response once headers arrive (a non-2xx/3xx status rejects before any body is read). */
function requestRange(url: string, startByte: number, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Download cancelled.'))
      return
    }
    const headers: Record<string, string> = startByte > 0 ? { Range: `bytes=${startByte}-` } : {}
    const req = rawGet(url, headers, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume()
        // HuggingFace resolve/main/<file> URLs redirect (absolute or relative Location) to the CDN.
        const next = new URL(res.headers.location, url).toString()
        requestRange(next, startByte, signal).then(resolve, reject)
        return
      }
      if (status !== 200 && status !== 206) {
        res.resume()
        reject(new Error(`HTTP ${status} for ${url}`))
        return
      }
      resolve(res)
    })
    req.on('error', reject)
    const onAbort = (): void => {
      req.destroy(new Error('Download cancelled.'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('close', () => signal.removeEventListener('abort', onAbort))
  })
}

/** Feed an existing partial file's bytes into a running hash before resuming — the final digest must
 *  cover the WHOLE file, not just the bytes fetched in this resumed session. */
function hashExistingPart(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  return new Promise((resolve, reject) => {
    const rs = createReadStream(path)
    // fs.ReadStream's 'data' event is typed `(chunk: string | Buffer) => void` (it only narrows to
    // Buffer once an encoding is set, which we never do) — normalize defensively even though this
    // stream always yields Buffer at runtime.
    rs.on('data', (chunk: string | Buffer) => hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    rs.on('end', resolve)
    rs.on('error', reject)
  })
}

/**
 * Download one file (gguf or mmproj) to `<userData>/local-llm/models/<modelId>/<file>`, streaming its
 * sha256 while writing. Resumable: a `.part` file present from a prior interrupted run is continued via
 * a `Range: bytes=<n>-` request; if the server ignores Range and answers 200 instead of 206, the partial
 * file is discarded and the download restarts clean (never silently corrupts the hash by mixing an
 * un-primed digest with resumed bytes). On a byte-count or checksum mismatch, the partial/finished file
 * is deleted and a typed error is thrown — no corrupt file is ever left at the final path.
 *
 * Exported as the primitive downloadModel() calls per-file — also exercised directly by tests against a
 * local mock HTTP server so checksum-reject/resume/RAM-gate cases never need the real Hugging Face URLs
 * baked into LOCAL_MODELS.
 */
export async function downloadModelFile(
  modelId: string,
  file: 'gguf' | 'mmproj',
  spec: LocalModelFile,
  signal: AbortSignal,
  onProgress?: ProgressCallback
): Promise<void> {
  const dest = filePath(modelId, file)
  mkdirSync(dirname(dest), { recursive: true })

  if (fileMatches(dest, spec.bytes)) return // already downloaded at the right size

  const partPath = `${dest}.part`
  let startByte = 0
  if (existsSync(partPath)) {
    const size = statSync(partPath).size
    if (size > 0 && size < spec.bytes) startByte = size
    else safeUnlink(partPath) // stale/oversized .part can't be resumed — start clean
  }

  // At most one restart: the first pass may discover the server ignored our Range header.
  for (let pass = 0; pass < 2; pass++) {
    const hash = createHash('sha256')
    if (startByte > 0) await hashExistingPart(partPath, hash)

    const res = await requestRange(spec.url, startByte, signal)
    if (startByte > 0 && res.statusCode !== 206) {
      // Server answered 200 (ignored Range) — the partial bytes can't be trusted as a true prefix of
      // this response body. Discard and restart from zero.
      res.resume()
      safeUnlink(partPath)
      startByte = 0
      continue
    }

    let received = startByte
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(partPath, { flags: startByte > 0 ? 'a' : 'w' })
      // IncomingMessage's 'data' event is typed `(chunk: string | Buffer) => void` — we never call
      // res.setEncoding(), so this is always a Buffer at runtime; normalize defensively for the hash.
      res.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        hash.update(buf)
        received += buf.length
        onProgress?.({ modelId, file, received, total: spec.bytes })
      })
      res.pipe(out)
      out.on('finish', () => {
        out.close()
        resolve()
      })
      out.on('error', reject)
      res.on('error', reject)
    })

    const finalSize = statSync(partPath).size
    if (finalSize !== spec.bytes) {
      safeUnlink(partPath)
      throw new IncompleteDownloadError(modelId, file, spec.bytes, finalSize)
    }
    const digest = hash.digest('hex')
    if (digest !== spec.sha256) {
      safeUnlink(partPath)
      localAudit('local.model.checksum_fail', { modelId, file })
      throw new ChecksumMismatchError(modelId, file, spec.sha256, digest)
    }
    renameSync(partPath, dest)
    return
  }
  throw new Error(`Download failed for ${modelId} (${file}): server did not honor the resume request.`)
}

/** Download both files (gguf + mmproj) for a manifest model. Refuses up front if this machine doesn't
 *  meet the model's RAM requirement. Progress is reported per-file via onProgress. */
export async function downloadModel(id: string, onProgress?: ProgressCallback): Promise<void> {
  const entry = getModel(id)
  assertRamOk(id)
  if (activeDownloads.has(id)) throw new Error(`A download for "${id}" is already in progress.`)

  const controller = new AbortController()
  activeDownloads.set(id, controller)
  try {
    await downloadModelFile(id, 'gguf', entry.gguf, controller.signal, onProgress)
    await downloadModelFile(id, 'mmproj', entry.mmproj, controller.signal, onProgress)
    localAudit('local.model.download', { modelId: id, bytes: entry.gguf.bytes + entry.mmproj.bytes })
  } finally {
    activeDownloads.delete(id)
  }
}

/** Aborts an in-flight downloadModel(id) call, if any. The partial `.part` file is left on disk so a
 *  later downloadModel(id) call can resume it — cancel is a pause, not a wipe. */
export function cancelDownload(id: string): void {
  activeDownloads.get(id)?.abort()
}
