import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { freemem, totalmem } from 'node:os'
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
  /**
   * llama-server total context (`-c`), shared across the two slots. Per-model because the KV cache — not
   * the weights — is what decides whether a model fits a small machine: the weights are mmapped and stay
   * page-cacheable, while the KV cache is committed up front and scales with layers x context. A 4B at
   * 64K would allocate far more for cache than for weights, so it takes a smaller window instead.
   */
  ctxSize: number
  gguf: LocalModelFile
  mmproj: LocalModelFile
}

/**
 * Order here is NOT meaningful — `bestModelForMachine()` ranks explicitly by RAM floor, so adding a model
 * is a registry edit and nothing else. Index 0 stays the smallest entry because it is the safe default a
 * fresh profile persists before boot can measure the hardware.
 *
 * Why the 4B is here: the 0.8B is measurably unreliable for real answers. Driving the packaged app
 * against it three times with identical settings produced "7. Mercury." for the largest planet and
 * "5 continents." twice — roughly a 40% factual-error rate on trivia, with run-to-run variance large
 * enough to swamp any prompt change. That is a model ceiling, not a prompt bug, and no amount of
 * OUTPUT FORMAT wording fixes it.
 *
 * Every size/sha256 below was READ FROM THE LIVE REPO at the pinned revision, never guessed. The method
 * was validated first against the 0.8B entry: the same probe reproduced its committed bytes and sha256
 * exactly, so the 4B values obtained the same way are trustworthy.
 */
export const LOCAL_MODELS: readonly LocalModelEntry[] = [
  {
    id: 'qwen3.5-0.8b',
    label: 'Qwen3.5 0.8B',
    minTotalRamGB: 8,
    // The original window: tiny model, so 65536 (32768 per slot) still costs little.
    ctxSize: 65536,
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
  },
  {
    id: 'qwen3.5-4b',
    label: 'Qwen3.5 4B',
    // 16384 total = 8192 per slot. Keeps the committed KV cache small enough that the 2.71 GB of mmapped
    // weights, not the cache, is the dominant cost on an 8 GB machine.
    ctxSize: 16384,
    // 8 GB is the deliberate target: the best model such a machine can actually hold. It works because
    // the two costs behave differently — llama.cpp mmaps the weights (no --no-mmap in buildSpawnArgs), so
    // the 2.71 GB is page-cache the OS can reclaim under pressure rather than committed RSS, while the KV
    // cache IS committed and is held down by the 16K window above. The 672 MB mmproj loads only when a
    // vision surface is live — and that is TRUE only since MQA-270 (B1): llama-server loads the projector
    // at STARTUP, not lazily, so before --no-mmproj this line was wrong and every text-only session paid
    // 1.03 GB for it anyway. Below 8 GB nothing is loadable at all and assertRamOk says so.
    minTotalRamGB: 8,
    gguf: {
      bytes: 2912109728,
      sha256: 'b252c5610a42ca82d20fe2a12813e9d069eed89292907e26c783eeb0bc961bc7',
      url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-UD-Q4_K_XL.gguf'
    },
    mmproj: {
      bytes: 672423616,
      sha256: 'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864',
      url: 'https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/mmproj-F16.gguf'
    }
  }
]

export function getModel(id: string): LocalModelEntry {
  const entry = LOCAL_MODELS.find((model) => model.id === id)
  if (!entry) throw new Error(`Unknown local model id: "${id}"`)
  return entry
}

/**
 * The strongest model this machine can hold. LOCAL_MODELS is ordered strongest-first, so this is the
 * first entry whose RAM floor fits; the smallest entry is the floor itself, returned even on a machine
 * below it so callers always get a model (the existing assertRamOk/shouldFetchWeights gates still refuse
 * to fetch or load it, which is where "this machine is too small" is reported — one place, not two).
 */
export function bestModelForMachine(): LocalModelEntry {
  const ram = advertisedRamGB()
  // Ranked by WEIGHT SIZE, not by RAM floor: two entries can share a floor (both are 8 GB today, since
  // the 4B fits there once its context window is sized for it), and ranking on a tied key would fall back
  // to array order — silently picking the weaker model. Bytes are an unambiguous capability proxy.
  const byCapability = [...LOCAL_MODELS].sort((a, b) => b.gguf.bytes - a.gguf.bytes)
  // Strongest that fits; otherwise the smallest entry, so callers always get a model. A machine below
  // even that floor is reported by assertRamOk/shouldFetchWeights — one place, not two.
  return byCapability.find((m) => ram >= m.minTotalRamGB) ?? byCapability[byCapability.length - 1]
}

/**
 * The model a given profile should actually use. A persisted id the user explicitly chose is honoured;
 * anything unknown (a removed id from an older profile) falls back to the best fit rather than throwing
 * a routing decision into getModel()'s "Unknown local model id" error.
 */
/**
 * How the sidecar should be sized for THIS machine.
 *
 * Measured on the packaged build with the 4B (committed private bytes, the figure that actually competes
 * for RAM):
 *   -ngl 99, ctx 16384, parallel 2  ->  5611 MB
 *   -ngl 0,  ctx 8192,  parallel 2  ->  2811 MB
 *   -ngl 0,  ctx 4096,  parallel 1  ->  1946 MB
 *
 * The dominant term is `-ngl`, not the context: offloading every layer costs ~3.2 GB of HOST-visible
 * memory on a machine whose GPU has no dedicated VRAM of its own, which is exactly the 8 GB laptop this
 * has to run on. Offload is therefore spent only where there is headroom to absorb it; below the
 * threshold the model runs on CPU, which is slower but actually fits. Two slots are kept either way so a
 * second concurrent ask still has somewhere to go.
 */
export interface LocalSpawnProfile {
  ctxSize: number
  parallel: number
  gpuLayers: number
}

/** RAM below which GPU offload is refused. 12 GB leaves an 8 GB machine on the CPU path with room to
 *  spare, while a 16 GB+ machine keeps the faster offloaded configuration. */
export const GPU_OFFLOAD_MIN_RAM_GB = 12

/** MQA-270 (B9): free RAM required before full GPU offload is chosen. `-ngl 99` on an INTEGRATED GPU
 *  offloads into host DRAM — the same memory everything else needs — and the profile was picked purely
 *  from totalmem(), so a 16 GB machine with 3 GB free still committed the full-offload footprint.
 *  freemem() under-reports on Windows (standby list excluded), so the threshold is generous; failing it
 *  falls to the small-machine profile, which costs speed, never correctness. */
export const GPU_OFFLOAD_MIN_FREE_RAM_GB = 5

export function spawnProfileFor(
  entry: LocalModelEntry,
  totalRamGB = totalRamGBValue(),
  freeRamGB = freeRamGBValue()
): LocalSpawnProfile {
  if (totalRamGB >= GPU_OFFLOAD_MIN_RAM_GB && freeRamGB >= GPU_OFFLOAD_MIN_FREE_RAM_GB) {
    return { ctxSize: entry.ctxSize, parallel: 2, gpuLayers: 99 }
  }
  // Small machine (or a big one that is currently squeezed): no offload, and a context halved from the
  // model's own ceiling so the committed KV cache stays small too. Measured at ~2.8 GB for the 4B,
  // which leaves an 8 GB machine ~5 GB.
  return { ctxSize: Math.min(entry.ctxSize, 8192), parallel: 2, gpuLayers: 0 }
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

/**
 * Advertised RAM class, not the raw GiB `totalmem()` returns.
 *
 * An 8 GB Mac or PC often reports 7.45–7.9 GiB (8×10^9 / 1024^3, plus firmware reservation). Comparing
 * that raw figure against `minTotalRamGB: 8` then refuses the first-run fetch on the exact machine the
 * 4B was sized for — Tony's "the local llm doesn’t even download". Ceil to the marketed GB so an 8 GB
 * class machine qualifies; a 4 GB / 6 GB box still fails. Spawn sizing keeps the raw value so we do not
 * GPU-offload on a squeezed machine.
 */
export function advertisedRamGB(bytes = totalmem()): number {
  return Math.ceil(bytes / 1024 ** 3)
}

/** Same value, exported name used by spawnProfileFor's default argument (declared above it). */
function freeRamGBValue(): number {
  return freemem() / 1024 ** 3
}

function totalRamGBValue(): number {
  return totalRamGB()
}

/** Refuse a load when the machine cannot safely run the bundled model. */
export function assertRamOk(id: string): void {
  const entry = getModel(id)
  const available = advertisedRamGB()
  if (available < entry.minTotalRamGB) {
    throw new InsufficientRamError(id, entry.minTotalRamGB, totalRamGB())
  }
}

/**
 * Spare room demanded on top of the weights. Same rationale as the downloader: a `.partial` write that
 * fills the startup volume to zero does not fail politely (Chromium CHECK / SIGTRAP, observed 2026-08-24).
 */
export const DISK_HEADROOM_BYTES = 512 * 1024 * 1024

function formatGb(n: number): string {
  return `${(n / 1e9).toFixed(1)} GB`
}

/** Free bytes on the volume that holds `dir`, or null if unmeasurable (fail open). */
export function volumeFreeBytes(dir: string): number | null {
  try {
    const fs = statfsSync(dir)
    return fs.bavail * fs.bsize
  } catch {
    return null
  }
}

/**
 * Why this machine cannot hold the weights right now, or null if the volume has room / cannot be
 * measured. Used by listModels so a refused fetch is `insufficient-disk` instead of silent `not-downloaded`
 * (Tony 2026-08-31: 99% full, Settings looked idle).
 */
export function diskShortageFor(id: string): string | null {
  const entry = getModel(id)
  const needed = entry.gguf.bytes + entry.mmproj.bytes + DISK_HEADROOM_BYTES
  let free = volumeFreeBytes(modelPaths(id).dir)
  if (free === null) {
    try {
      free = volumeFreeBytes(app.getPath('userData'))
    } catch {
      return null
    }
  }
  if (free === null || free >= needed) return null
  return (
    `Not enough free disk space — needs ${formatGb(needed)} (${formatGb(entry.gguf.bytes + entry.mmproj.bytes)} of ` +
    `weights plus ${formatGb(DISK_HEADROOM_BYTES)} of headroom) but only ${formatGb(free)} is available.`
  )
}

/** Refuse a transfer the volume cannot hold, BEFORE a single byte is written. Unmeasurable → proceed. */
export function assertRoomFor(bytes: number, dir: string, file: string): void {
  const freeBytes = volumeFreeBytes(dir)
  if (freeBytes === null) return
  const needed = bytes + DISK_HEADROOM_BYTES
  if (freeBytes >= needed) return
  throw new Error(
    `${file}: not enough free disk space — needs ${formatGb(needed)} (${formatGb(bytes)} of weights plus ` +
      `${formatGb(DISK_HEADROOM_BYTES)} of headroom) but only ${formatGb(freeBytes)} is available. ` +
      `Free up space and tap Retry.`
  )
}

export interface LocalModelPaths {
  dir: string
  gguf: string
  mmproj: string
  /** The model's context window, carried alongside its files so a caller that has the paths never has to
   *  look the sizing up separately (and cannot forget to). */
  ctxSize: number
  parallel: number
  gpuLayers: number
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
  const entry = getModel(id)
  const dir = join(modelsRoot(), id)
  const profile = spawnProfileFor(entry)
  return {
    dir,
    gguf: join(dir, 'model.gguf'),
    mmproj: join(dir, 'mmproj.gguf'),
    ctxSize: profile.ctxSize,
    parallel: profile.parallel,
    gpuLayers: profile.gpuLayers
  }
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
 * Means "both weight files are on disk with their pinned sizes" - they arrive over the network on first
 * run (local-model-download.ts), they are never in the installer.
 */
export function isDownloaded(id: string): boolean {
  const entry = getModel(id)
  const paths = modelPaths(id)
  return fileMatches(paths.gguf, entry.gguf.bytes) && fileMatches(paths.mmproj, entry.mmproj.bytes)
}

/**
 * Live state of the first-run weight fetch. The VALUE lives in local-model-download.ts (which owns the
 * transfer); the TYPE lives here so listModels() can fold it into the one summary the renderer already
 * polls. Absent "files are missing" is ambiguous between "downloading right now", "the fetch failed" and
 * "never attempted" - and the renderer told users to reinstall for all three (MQA-187/188/191).
 */
export interface LocalModelDownloadState {
  modelId: string | null
  status: 'idle' | 'downloading' | 'failed'
  /** 0..1 across BOTH files, weighted by their pinned byte counts. Meaningful while `downloading`. */
  progress: number
  /** Set while `status === 'failed'` — disk, HTTP, hash, or network. Omitted otherwise. */
  error?: string
}

export type LocalModelUnavailableReason =
  | 'insufficient-ram'
  | 'insufficient-disk'
  | 'downloading'
  | 'download-failed'
  | 'not-downloaded'

export interface LocalModelSummary {
  id: string
  label: string
  minTotalRamGB: number
  ready: boolean
  unavailableReason: LocalModelUnavailableReason | null
  /** 0..1 while `unavailableReason === 'downloading'`, 0 otherwise. */
  downloadProgress: number
  /** Concrete refuse/fail reason while `unavailableReason === 'download-failed'`. */
  downloadError: string | null
}

export function listModels(download?: LocalModelDownloadState): LocalModelSummary[] {
  return LOCAL_MODELS.map((model) => {
    const filesPresent = isDownloaded(model.id)
    const enoughRam = advertisedRamGB() >= model.minTotalRamGB
    const dl = download && download.modelId === model.id ? download : undefined
    const diskError = filesPresent ? null : diskShortageFor(model.id)
    // RAM then disk, both independent of download state: a skipped fetch (boot never called
    // ensureLocalModel, or assertRoomFor refused before net.fetch) must not read as idle `not-downloaded`.
    const reason: LocalModelUnavailableReason | null = !enoughRam
      ? 'insufficient-ram'
      : filesPresent
        ? null
        : dl?.status === 'downloading'
          ? 'downloading'
          : diskError || (dl?.status === 'failed' && /not enough free disk/i.test(dl.error ?? ''))
            ? 'insufficient-disk'
            : dl?.status === 'failed'
              ? 'download-failed'
              : 'not-downloaded'
    return {
      id: model.id,
      label: model.label,
      minTotalRamGB: model.minTotalRamGB,
      ready: filesPresent && enoughRam,
      unavailableReason: reason,
      downloadProgress: reason === 'downloading' ? (dl?.progress ?? 0) : 0,
      downloadError:
        reason === 'download-failed' || reason === 'insufficient-disk'
          ? (dl?.error ?? diskError ?? null)
          : null
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
