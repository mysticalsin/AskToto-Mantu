import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { totalmem } from 'node:os'
import { auditLog, type AuditEvent } from '../logger'

/**
 * Code-reviewed metadata for the Métis Local model payload.
 *
 * These weights are NO LONGER embedded in the installer. At ~728 MB they dominated the download, and
 * a universal (Intel + Apple Silicon) package cannot carry them and still fit GitHub's 2 GB per-asset
 * release limit. They are fetched once, on first run, by local-model-download.ts.
 *
 * That moves a supply-chain step from build time to run time, so the pins below are what keep it safe
 * and are NOT advisory: `url` points at an IMMUTABLE upstream revision (a commit hash in the path, not
 * a branch), and a downloaded file must match `bytes` and `sha256` exactly or it is deleted instead of
 * used. Never relax these to a mutable ref or a size-only check.
 */
export interface LocalModelFile {
  bytes: number
  sha256: string
  /** Pinned upstream source. Read only by the first-run downloader. */
  url: string
}

export interface LocalModelEntry {
  id: string
  label: string
  minTotalRamGB: number
  gguf: LocalModelFile
  mmproj: LocalModelFile
}

export const LOCAL_MODELS: readonly LocalModelEntry[] = [
  {
    id: 'qwen3.5-0.8b',
    label: 'Qwen3.5 0.8B',
    minTotalRamGB: 8,
    gguf: {
      bytes: 558772480,
      sha256: '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5',
      url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-UD-Q4_K_XL.gguf'
    },
    mmproj: {
      bytes: 204987232,
      sha256: '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453',
      url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/mmproj-F16.gguf'
    }
  }
]

export function getModel(id: string): LocalModelEntry {
  const entry = LOCAL_MODELS.find((model) => model.id === id)
  if (!entry) throw new Error(`Unknown local model id: "${id}"`)
  return entry
}

export class InsufficientRamError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly requiredGB: number,
    public readonly availableGB: number,
    public readonly suggestion?: LocalModelEntry
  ) {
    super(`This model needs at least ${requiredGB} GB of RAM; this machine has ${availableGB.toFixed(1)} GB.`)
    this.name = 'InsufficientRamError'
  }
}

export class ChecksumMismatchError extends Error {
  constructor(
    public readonly modelId: string,
    public readonly file: 'gguf' | 'mmproj',
    public readonly expectedSha256: string,
    public readonly actualSha256: string
  ) {
    super(
      `Model integrity check failed for ${modelId} (${file}): expected ` +
        `${expectedSha256.slice(0, 8)}..., got ${actualSha256.slice(0, 8)}.... The file will be re-downloaded.`
    )
    this.name = 'ChecksumMismatchError'
  }
}

type LocalModelAuditEvent = Extract<AuditEvent, `local.model.${string}`>
function localAudit(event: LocalModelAuditEvent, detail: Record<string, unknown>): void {
  auditLog(event, detail)
}

function totalRamGB(): number {
  return totalmem() / 1024 ** 3
}

/** Refuse a load when the machine cannot safely run the bundled model. */
export function assertRamOk(id: string): void {
  const entry = getModel(id)
  const available = totalRamGB()
  if (available < entry.minTotalRamGB) {
    throw new InsufficientRamError(id, entry.minTotalRamGB, available)
  }
}

export interface LocalModelPaths {
  dir: string
  gguf: string
  mmproj: string
}

/**
 * Always userData, packaged or not: the weights are downloaded on first run, and the .app bundle is
 * read-only and code-signed — writing into process.resourcesPath would break its seal.
 */
export function modelsRoot(): string {
  return join(app.getPath('userData'), 'local-llm', 'models')
}

/** Main-process-only paths, under the writable per-user model directory. */
export function modelPaths(id: string): LocalModelPaths {
  getModel(id)
  const dir = join(modelsRoot(), id)
  return { dir, gguf: join(dir, 'model.gguf'), mmproj: join(dir, 'mmproj.gguf') }
}

function fileMatches(path: string, expectedBytes: number): boolean {
  try {
    return statSync(path).size === expectedBytes
  } catch {
    return false
  }
}

/**
 * Kept under its existing internal name because local routing already consumes it.
 * In packaged builds this means "the bundled files are present with pinned sizes".
 */
export function isDownloaded(id: string): boolean {
  const entry = getModel(id)
  const paths = modelPaths(id)
  return fileMatches(paths.gguf, entry.gguf.bytes) && fileMatches(paths.mmproj, entry.mmproj.bytes)
}

export interface LocalModelSummary {
  id: string
  label: string
  minTotalRamGB: number
  ready: boolean
  unavailableReason: 'missing-files' | 'insufficient-ram' | null
}

export function listModels(): LocalModelSummary[] {
  return LOCAL_MODELS.map((model) => {
    const filesPresent = isDownloaded(model.id)
    const enoughRam = totalRamGB() >= model.minTotalRamGB
    return {
      id: model.id,
      label: model.label,
      minTotalRamGB: model.minTotalRamGB,
      ready: filesPresent && enoughRam,
      unavailableReason: !filesPresent ? 'missing-files' : enoughRam ? null : 'insufficient-ram'
    }
  })
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk: string | Buffer) => {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

async function verifyFileChecksum(
  modelId: string,
  file: 'gguf' | 'mmproj',
  path: string,
  spec: LocalModelFile
): Promise<void> {
  const digest = await hashFile(path)
  if (digest !== spec.sha256) {
    localAudit('local.model.checksum_fail', { modelId, file })
    throw new ChecksumMismatchError(modelId, file, spec.sha256, digest)
  }
}

/** Re-hash both model files before a cold llama-server start. */
export async function verifyIntegrity(id: string): Promise<void> {
  assertRamOk(id)
  const entry = getModel(id)
  const paths = modelPaths(id)
  for (const file of ['gguf', 'mmproj'] as const) {
    const path = paths[file]
    if (!existsSync(path)) {
      throw new Error(
        `Local model "${id}" (${file}) is not downloaded yet. Métis fetches it automatically on first run; ` +
          `check the connection if this persists.`
      )
    }
    await verifyFileChecksum(id, file, path, entry[file])
  }
}
