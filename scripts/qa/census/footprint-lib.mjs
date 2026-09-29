import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readSync } from 'node:fs'
import { arch, cpus, platform as osPlatform, release, totalmem } from 'node:os'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

export const FOOTPRINT_SCHEMA = 'metis-resource-footprint/1'
// Files below this size cannot be a meaningful duplicated runtime or weight.
export const DEFAULT_DUPLICATE_MIN_BYTES = 1024 * 1024

const WEIGHT_EXTENSIONS = new Set(['.gguf', '.onnx', '.safetensors', '.mlmodel', '.mlpackage', '.ggml', '.bin'])
const RUNTIME_EXTENSIONS = new Set(['.dylib', '.dll', '.node', '.so', '.exe'])

export function classifyFile(relativePath) {
  const ext = extname(relativePath).toLowerCase()
  if (WEIGHT_EXTENSIONS.has(ext)) return 'weights'
  if (RUNTIME_EXTENSIONS.has(ext)) return 'runtime'
  const name = basename(relativePath).toLowerCase()
  if (name.includes('llama-server') || name.includes('electron framework') || name === 'ffmpeg') return 'runtime'
  return 'other'
}

export function sha256File(path) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  const fd = openSync(path, 'r')
  try {
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** Regular files under root (symlinks are never followed or counted), as { path, size }. */
export function listRegularFiles(root, { exclude = [] } = {}) {
  const skipped = exclude.map((p) => resolve(p))
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (skipped.includes(resolve(full))) continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files.push({ path: full, size: lstatSync(full).size })
    }
  }
  walk(resolve(root))
  return files
}

export function directoryBytes(root, options) {
  const files = listRegularFiles(root, options)
  return { bytes: files.reduce((sum, f) => sum + f.size, 0), fileCount: files.length }
}

/** Groups byte-identical files of at least minBytes; wasted bytes count every copy after the first. */
export function findDuplicates(root, { minBytes = DEFAULT_DUPLICATE_MIN_BYTES } = {}) {
  const base = resolve(root)
  const bySize = new Map()
  for (const file of listRegularFiles(base)) {
    if (file.size < minBytes) continue
    bySize.set(file.size, [...(bySize.get(file.size) ?? []), file])
  }
  const byHash = new Map()
  for (const candidates of bySize.values()) {
    if (candidates.length < 2) continue
    for (const file of candidates) {
      const key = `${file.size}:${sha256File(file.path)}`
      byHash.set(key, [...(byHash.get(key) ?? []), file])
    }
  }
  const groups = []
  for (const [key, copies] of byHash) {
    if (copies.length < 2) continue
    const size = copies[0].size
    const paths = copies.map((c) => relative(base, c.path).split(sep).join('/')).sort()
    groups.push({
      sha256: key.split(':')[1],
      size,
      kind: classifyFile(paths[0]),
      copies: copies.length,
      wastedBytes: size * (copies.length - 1),
      paths
    })
  }
  groups.sort((a, b) => b.wastedBytes - a.wastedBytes || a.sha256.localeCompare(b.sha256))
  const wastedByKind = { runtime: 0, weights: 0, other: 0 }
  for (const g of groups) wastedByKind[g.kind] += g.wastedBytes
  return {
    minBytes,
    groups,
    wastedBytes: groups.reduce((sum, g) => sum + g.wastedBytes, 0),
    wastedByKind
  }
}

/**
 * Runs a command with TEMP/TMP/TMPDIR pointed at tempDir and polls that directory, so the bytes an installer
 * unpacks and later deletes are captured. peakBytes is the largest sample, including one taken at exit.
 */
export async function runWithTempPeak({ command, args = [], tempDir, intervalMs = 100 }) {
  const dir = resolve(tempDir)
  mkdirSync(dir, { recursive: true })
  let peakBytes = 0
  let samples = 0
  const sample = () => {
    try {
      peakBytes = Math.max(peakBytes, directoryBytes(dir).bytes)
      samples += 1
    } catch {
      // A file vanished between listing and stat while the installer cleaned up; the next sample recovers.
    }
  }
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir } })
  const timer = setInterval(sample, intervalMs)
  try {
    const exitCode = await new Promise((done, fail) => {
      child.once('error', fail)
      child.once('close', (code) => done(code ?? 1))
    })
    sample()
    return { exitCode, peakBytes, samples, intervalMs }
  } finally {
    clearInterval(timer)
  }
}

export function parseTtfcBenchOutput(text) {
  const output = String(text ?? '')
  const match = /^\s*TTFC budget:\s*(\d+)\s*ms\s*$/im.exec(output)
  if (!match || /^FAIL:/m.test(output)) {
    throw new Error('TTFC artifact is not a passing scripts/bench-asr-ttfc.mjs run')
  }
  const stub = /^\s*stub decode:\s*(\d+)\s*ms\s*$/im.exec(output)
  return { schedulingBudgetMs: Number(match[1]), stubDecodeMs: stub ? Number(stub[1]) : null }
}

export function parseMacGpus(json) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json
  return (parsed?.SPDisplaysDataType ?? [])
    .map((d) => ({ name: String(d.sppci_model ?? d._name ?? ''), cores: d.sppci_cores ? String(d.sppci_cores) : null }))
    .filter((d) => d.name)
}

export function parseWindowsGpus(json) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
  return rows
    .map((d) => ({ name: String(d.Name ?? ''), driverVersion: d.DriverVersion ? String(d.DriverVersion) : null }))
    .filter((d) => d.name)
}

/** Locale codes shipped with the installed app: *.lproj on macOS, locales/*.pak on Windows. */
export function shippedLocales(installRoot, platform) {
  const codes = new Set()
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (platform === 'darwin' && entry.isDirectory() && entry.name.endsWith('.lproj')) {
        codes.add(entry.name.slice(0, -'.lproj'.length))
      } else if (platform === 'win32' && entry.isFile() && extname(entry.name) === '.pak' && basename(dir) === 'locales') {
        codes.add(entry.name.slice(0, -'.pak'.length))
      } else if (entry.isDirectory() && depth < 4) walk(full, depth + 1)
    }
  }
  walk(resolve(installRoot), 0)
  return [...codes].sort()
}

function tryExec(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 32 * 1024 * 1024 })
  } catch {
    return null
  }
}

/** GPU list, or null when the OS query is unavailable so the row is reported as unmeasured. */
export function collectGpus(platform = osPlatform()) {
  if (platform === 'darwin') {
    const raw = tryExec('system_profiler', ['SPDisplaysDataType', '-json'])
    return raw === null ? null : parseMacGpus(raw)
  }
  if (platform === 'win32') {
    const raw = tryExec('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress'
    ])
    return raw === null || !raw.trim() ? null : parseWindowsGpus(raw)
  }
  return null
}

export function collectInventory({ installRoot, platform = osPlatform() }) {
  const cpu = cpus()
  return {
    platform,
    arch: arch(),
    osRelease: release(),
    cpuModel: cpu[0]?.model ?? null,
    logicalCpus: cpu.length,
    totalMemoryBytes: totalmem(),
    gpus: collectGpus(platform),
    systemLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    appLocales: shippedLocales(installRoot, platform)
  }
}

/** Rows a hosted runner cannot measure. Each names the exact step that unblocks it. */
export function unmeasuredRows({ hasLiveCaptureLatency, hasTemporaryInstallBytes = true }) {
  const rows = [
    {
      row: 'managed-laptop-footprint',
      status: 'BLOCKED_EXTERNAL',
      unblock: 'Run this tool on a managed corporate laptop with the same release artifact and attach its JSON.'
    },
    {
      row: 'npu-or-neural-engine',
      status: 'UNKNOWN',
      unblock: 'Hosted runners do not enumerate NPU or Neural Engine hardware; inventory it on a physical QA machine.'
    },
    {
      row: 'audio-capture-devices',
      status: 'BLOCKED_EXTERNAL',
      unblock: 'Hosted runners have no microphone or loopback device; enumerate on a physical QA machine.'
    }
  ]
  if (!hasTemporaryInstallBytes) {
    rows.push({
      row: 'temporary-install-bytes',
      status: 'UNKNOWN',
      unblock:
        'Run the install through scripts/qa/census/measure-install.mjs and pass its JSON to footprint.mjs --temp-peak.'
    })
  }
  if (!hasLiveCaptureLatency) {
    rows.push({
      row: 'live-capture-to-caption-latency',
      status: 'BLOCKED_EXTERNAL',
      unblock:
        'Needs real audio capture through the packaged app on a physical QA machine; the hosted lane records only the scheduling budget.'
    })
  }
  return rows
}

export function buildFootprintReport({ releaseTag, runId, artifact, unpacked, temporary, duplicates, latency, inventory }) {
  return {
    schema: FOOTPRINT_SCHEMA,
    releaseTag,
    runId,
    platform: inventory.platform,
    arch: inventory.arch,
    artifact,
    sizes: {
      compressedBytes: artifact.bytes,
      unpackedBytes: unpacked.bytes,
      unpackedFileCount: unpacked.fileCount,
      temporaryBytes: temporary?.peakBytes ?? null,
      temporaryScope: temporary?.scope ?? null
    },
    duplicates,
    latency,
    inventory,
    unmeasured: unmeasuredRows({
      hasLiveCaptureLatency: latency.liveCaptureToCaptionMs != null,
      hasTemporaryInstallBytes: temporary != null
    })
  }
}
