/**
 * One-click, in-app installer for the "managed" CLI backends (Claude Code, later OpenAI Codex) — no
 * system Node.js required. Onboarding calls installManagedCli() so a user can click "Install" and get a
 * fully working `claude`/`codex` entry point without ever opening a terminal or installing Node.
 *
 * HOW THIS AVOIDS REQUIRING NODE: the npm package is fetched straight from the registry as a tarball and
 * unpacked into userData — no `npm` invocation at all. Running the resulting `cli.js` needs a JS runtime;
 * Electron's own binary IS a JS runtime (V8 + a bundled Node core) and, when spawned with the
 * ELECTRON_RUN_AS_NODE=1 env var, boots as a plain Node.js process instead of Electron/Chromium — so
 * `process.execPath` (this app's own executable) can run the installed entry point directly (see
 * managedCliCommand below). This is a documented Electron capability, not a private trick.
 *
 * SECURITY INVARIANTS (never relax):
 *   - Tarball bytes are verified against the npm registry's published `dist.integrity` (sha512) BEFORE
 *     anything is written to disk. A mismatch is a hard error and leaves no trace on disk.
 *   - The vendored tar reader rejects any entry whose path is absolute or contains a '..' segment
 *     (zip-slip) — such an entry aborts the whole install rather than being silently skipped.
 *   - Extraction happens into a `<version>.tmp-<random>` scratch directory and is only promoted to the
 *     real `<version>/` directory (via rename) once every check above has passed, so a partial/failed
 *     install (including a mid-flight AbortSignal cancel) never leaves a half-written version directory
 *     behind for managedCliEntry() to find.
 *   - `current.json` (the version pointer managedCliEntry()/managedCliCommand() read) is written via a
 *     temp-file + rename, so a crash mid-write can never leave a torn/partial pointer on disk.
 *
 * KNOWN LIMITATION: the vendored tar reader below is intentionally minimal — plain ustar headers only
 * (name/prefix fields, octal sizes, 512-byte blocks/padding). It does NOT understand GNU longname or PAX
 * extended-header records for paths over the ustar 100-char name limit; such an entry would extract under
 * its truncated ustar name instead of the intended long path. It silently skips (but correctly seeks past)
 * any header type it doesn't recognize — including PAX global headers, which real npm-published tarballs
 * commonly carry — so those do not break extraction of the regular files/dirs we actually need.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import { app } from 'electron'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ─── Public types ──────────────────────────────────────────────────────────────────

export interface CliInstallProgress {
  phase: 'resolving' | 'downloading' | 'extracting' | 'verifying' | 'done' | 'error'
  receivedBytes?: number
  totalBytes?: number
  etaMs?: number | null
  error?: string
}

export interface ManagedCliSpec {
  id: 'claude' | 'codex' | 'dust'
  npmPackage: string
  binRelPath: string
  /** When set, fetch this packument instead of /latest (Dust 0.4.6 shipped without `diff`). */
  pinVersion?: string
  /** Runtime packages the published tarball imports but may omit from dependencies. */
  ensurePackages?: string[]
}

export type ManagedCliId = ManagedCliSpec['id']

/** Known-good Dust CLI. 0.4.6 (and any latest that drops `diff`) looks dead after unpack. */
export const DUST_CLI_PINNED_VERSION = '0.4.5'
export const DUST_CLI_ENSURE_PACKAGES = ['diff'] as const

export const MANAGED_CLIS: Record<ManagedCliId, ManagedCliSpec> = {
  claude: {
    id: 'claude',
    npmPackage: '@anthropic-ai/claude-code',
    binRelPath: 'cli.js'
  },
  codex: {
    id: 'codex',
    npmPackage: '@openai/codex',
    // TODO-verify: confirm the real packaged entry point by inspecting an actual @openai/codex npm
    // tarball once it's available — this mirrors claude's single-JS-entry layout but codex's bin
    // layout hasn't been verified directly.
    binRelPath: 'bin/codex.js'
  },
  dust: {
    id: 'dust',
    npmPackage: '@dust-tt/dust-cli',
    binRelPath: 'dist/index.js',
    pinVersion: DUST_CLI_PINNED_VERSION,
    ensurePackages: [...DUST_CLI_ENSURE_PACKAGES]
  }
}

function installRoot(id: ManagedCliId): string {
  return join(app.getPath('userData'), 'managed-cli', id)
}

// ─── Cancellation ──────────────────────────────────────────────────────────────────

class CliInstallAbortError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CliInstallAbortError'
  }
}

/** True for our own cancellation sentinel, a fetch/stream AbortError, or a signal already flagged
 *  aborted by the time the error surfaced — any of these means the caller asked to stop, not a real
 *  failure. */
function isCancellation(err: unknown, signal: AbortSignal | undefined): boolean {
  if (err instanceof CliInstallAbortError) return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return !!signal?.aborted
}

// ─── Vendored minimal tar reader (see KNOWN LIMITATION in the module doc comment) ──────────────────

const TAR_BLOCK = 512

interface TarEntry {
  name: string
  type: string
  data: Buffer
}

/** Read a NUL-terminated (or fully-padded) ASCII field out of a tar header block. */
function readTarField(header: Buffer, start: number, length: number): string {
  const slice = header.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return slice.toString('utf8', 0, nul === -1 ? slice.length : nul)
}

/** Tar sizes are ASCII octal, NUL/space padded. Empty/garbage fields read as 0 rather than throwing —
 *  this is a minimal reader, not a validating one (see module doc comment). */
function readOctalField(header: Buffer, start: number, length: number): number {
  const raw = readTarField(header, start, length).trim()
  if (!raw) return 0
  const n = parseInt(raw, 8)
  return Number.isFinite(n) ? n : 0
}

/** Parse a ustar byte buffer into entries. Stops at the first all-zero header block (standard tar
 *  end-of-archive marker) or when fewer than 512 bytes remain. Every entry's data is fully materialized
 *  in memory — fine for CLI-sized npm packages (single-digit MB), not meant for huge archives. */
function readTarEntries(tarBuf: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + TAR_BLOCK <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + TAR_BLOCK)
    if (header.every((b) => b === 0)) break

    const name = readTarField(header, 0, 100)
    const type = String.fromCharCode(header[156] || 0)
    const size = readOctalField(header, 124, 12)
    const prefix = readTarField(header, 345, 155)
    const fullName = prefix ? `${prefix}/${name}` : name

    offset += TAR_BLOCK
    const data = Buffer.from(tarBuf.subarray(offset, offset + size))
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK

    entries.push({ name: fullName, type, data })
  }
  return entries
}

/** Zip-slip guard: reject an absolute path (POSIX or a Windows drive letter) or any path containing a
 *  '..' segment. Called before a single byte of the entry is written. */
function assertSafeTarPath(name: string): void {
  if (!name || name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) {
    throw new Error(`unsafe tar entry — absolute path: '${name}'`)
  }
  if (name.split(/[\\/]/).includes('..')) {
    throw new Error(`unsafe tar entry — path contains '..': '${name}'`)
  }
}

/** Gunzip + extract a npm tarball into `destDir`. Only regular files ('0'/'') and directories ('5') are
 *  materialized; every other tar entry type (symlinks, PAX headers, etc.) is skipped — see the module doc
 *  comment's KNOWN LIMITATION. */
function extractTarball(gz: Buffer, destDir: string): void {
  const tarBuf = gunzipSync(gz)
  for (const entry of readTarEntries(tarBuf)) {
    if (entry.type !== '0' && entry.type !== '' && entry.type !== '5') continue
    assertSafeTarPath(entry.name)
    const target = join(destDir, entry.name)
    if (entry.type === '5') {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
  }
}

// ─── npm registry lookup + tarball download ────────────────────────────────────────

interface NpmLatestMeta {
  version: string
  tarball: string
  integrity: string
}

/** The npm registry's per-version packument lookup. Scoped package names contain a literal '/' between
 *  scope and name, which must be percent-encoded (the registry treats an unescaped '/' as a path
 *  separator); the leading '@' is conventionally left unescaped. */
function registryPackumentUrl(npmPackage: string, pinVersion?: string): string {
  const encoded = npmPackage.replace('/', '%2f')
  return pinVersion
    ? `https://registry.npmjs.org/${encoded}/${pinVersion}`
    : `https://registry.npmjs.org/${encoded}/latest`
}

/**
 * Patch package.json so a published tarball that `require`s a package it forgot to declare
 * (Dust CLI 0.4.6 / `diff`) still gets that dep before we call the binary live.
 */
export function ensurePackageJsonDeps(
  raw: string,
  packages: readonly string[]
): { json: string; added: string[] } {
  let parsed: { dependencies?: Record<string, string> }
  try {
    parsed = JSON.parse(raw) as { dependencies?: Record<string, string> }
  } catch {
    return { json: raw, added: [] }
  }
  const deps = { ...(parsed.dependencies ?? {}) }
  const added: string[] = []
  for (const name of packages) {
    if (!deps[name]) {
      deps[name] = '*'
      added.push(name)
    }
  }
  if (added.length === 0) return { json: raw, added }
  return { json: JSON.stringify({ ...parsed, dependencies: deps }, null, 2), added }
}

async function fetchLatestMeta(
  npmPackage: string,
  signal: AbortSignal | undefined,
  pinVersion?: string
): Promise<NpmLatestMeta> {
  const res = await fetch(registryPackumentUrl(npmPackage, pinVersion), { signal })
  if (!res.ok) {
    throw new Error(`npm registry lookup failed for ${npmPackage}: HTTP ${res.status}`)
  }
  const json = (await res.json()) as { version?: unknown; dist?: { tarball?: unknown; integrity?: unknown } }
  const { version, dist } = json
  if (typeof version !== 'string' || typeof dist?.tarball !== 'string' || typeof dist?.integrity !== 'string') {
    throw new Error(`npm registry response for ${npmPackage} is missing version/dist.tarball/dist.integrity`)
  }
  return { version, tarball: dist.tarball, integrity: dist.integrity }
}

/** Verify the downloaded tarball bytes against npm's published `dist.integrity` (a Subresource-Integrity
 *  string, "sha512-<base64>"). Only the sha512 form is supported — that is what the modern registry always
 *  publishes for current package versions. Throws on any mismatch; caller must not write anything to disk
 *  before this passes. */
function verifyIntegrity(buf: Buffer, integrity: string): void {
  const prefix = 'sha512-'
  if (!integrity.startsWith(prefix)) {
    throw new Error(`unsupported integrity format (expected '${prefix}<base64>'): '${integrity}'`)
  }
  const expected = integrity.slice(prefix.length)
  const actual = createHash('sha512').update(buf).digest('base64')
  if (actual !== expected) {
    throw new Error('tarball integrity check failed — downloaded bytes do not match the registry-published sha512')
  }
}

// Minimum spacing between emitted 'downloading' progress events, and how many of those emitted samples
// feed the rolling-average ETA below. Both numbers are part of the documented design, not tunables.
const DOWNLOAD_PROGRESS_MIN_INTERVAL_MS = 250
const ETA_SAMPLE_WINDOW = 5

interface ProgressSample {
  t: number
  bytes: number
}

/** Rolling-average download rate from the oldest vs. newest of the last ETA_SAMPLE_WINDOW emitted
 *  progress samples, projected against the remaining bytes. Using the window's endpoints (rather than
 *  averaging each individual inter-sample rate) IS the windowed average — it's the total bytes moved over
 *  the total time elapsed across the window — while staying cheap and immune to noise from any single
 *  tiny tick. Returns null whenever the total size is unknown or there isn't yet enough signal (fewer
 *  than 2 samples, or no measurable time/byte delta). */
function computeEtaMs(samples: ProgressSample[], totalBytes: number | undefined, receivedBytes: number): number | null {
  if (totalBytes === undefined || samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const dt = last.t - first.t
  const dBytes = last.bytes - first.bytes
  if (dt <= 0 || dBytes <= 0) return null
  const bytesPerMs = dBytes / dt
  const remaining = Math.max(totalBytes - receivedBytes, 0)
  return Math.round(remaining / bytesPerMs)
}

/** Stream-download the tarball, emitting throttled 'downloading' progress (receivedBytes/totalBytes/etaMs)
 *  as it goes. `totalBytes` is undefined when the server omits Content-Length (etaMs then stays null — no
 *  size to project against). Checks `signal` both proactively (before/after each read) and by handing it
 *  to fetch() itself, so an abort mid-stream stops promptly either way. */
async function downloadTarball(
  url: string,
  onProgress: (p: CliInstallProgress) => void,
  signal: AbortSignal | undefined
): Promise<Buffer> {
  const res = await fetch(url, { signal })
  if (!res.ok || !res.body) {
    throw new Error(`tarball download failed (${url}): HTTP ${res.status}`)
  }
  const totalHeader = res.headers.get('content-length')
  const totalBytes = totalHeader ? Number(totalHeader) : undefined

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  const samples: ProgressSample[] = []
  let lastEmitAt = -Infinity

  const emit = (force: boolean): void => {
    const now = Date.now()
    if (!force && now - lastEmitAt < DOWNLOAD_PROGRESS_MIN_INTERVAL_MS) return
    lastEmitAt = now
    samples.push({ t: now, bytes: receivedBytes })
    if (samples.length > ETA_SAMPLE_WINDOW) samples.shift()
    onProgress({
      phase: 'downloading',
      receivedBytes,
      totalBytes,
      etaMs: computeEtaMs(samples, totalBytes, receivedBytes)
    })
  }

  emit(true) // announce the phase transition immediately, even before the first chunk arrives

  for (;;) {
    if (signal?.aborted) throw new CliInstallAbortError()
    const { done, value } = await reader.read()
    if (signal?.aborted) throw new CliInstallAbortError()
    if (done) break
    if (value) {
      chunks.push(value)
      receivedBytes += value.byteLength
      emit(false)
    }
  }
  emit(true) // final sample at 100% regardless of the throttle window

  return Buffer.concat(chunks)
}

// ─── current.json pointer ───────────────────────────────────────────────────────────

interface CurrentPointer {
  version: string
  entry: string
}

function currentJsonPath(id: ManagedCliId): string {
  return join(installRoot(id), 'current.json')
}

/** Temp-file + rename so a crash mid-write can never leave a torn current.json for managedCliEntry() to
 *  read (rename is atomic on both APFS and NTFS within the same volume, which installRoot() always is). */
function writeCurrentPointerAtomic(id: ManagedCliId, pointer: CurrentPointer): void {
  const dir = installRoot(id)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.current.json.tmp-${randomBytes(6).toString('hex')}`)
  writeFileSync(tmp, JSON.stringify(pointer, null, 2), 'utf8')
  renameSync(tmp, currentJsonPath(id))
}

// ─── installManagedCli ──────────────────────────────────────────────────────────────

/**
 * Install `id`'s CLI package from npm into userData, entirely in-process — no `npm`, no system Node.js.
 * Reports progress through the resolving → downloading → verifying → extracting → done phases (or
 * 'error', including on cancellation via `signal`, where CliInstallProgress.error is exactly 'cancelled').
 * Resolves with the installed entry's absolute path and version once current.json has been durably
 * written; rejects (after emitting a final 'error' progress) on any failure, leaving nothing on disk that
 * managedCliEntry() would treat as a valid install.
 */
export async function installManagedCli(
  id: ManagedCliId,
  onProgress: (p: CliInstallProgress) => void,
  signal?: AbortSignal
): Promise<{ entry: string; version: string }> {
  const spec = MANAGED_CLIS[id]
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new CliInstallAbortError()
  }

  let tmpDir: string | null = null
  try {
    throwIfAborted()
    onProgress({ phase: 'resolving' })
    const meta = await fetchLatestMeta(spec.npmPackage, signal, spec.pinVersion)

    throwIfAborted()
    const buf = await downloadTarball(meta.tarball, onProgress, signal)

    throwIfAborted()
    onProgress({ phase: 'verifying' })
    verifyIntegrity(buf, meta.integrity)

    throwIfAborted()
    onProgress({ phase: 'extracting' })
    const versionDir = join(installRoot(id), meta.version)
    tmpDir = `${versionDir}.tmp-${randomBytes(6).toString('hex')}`
    mkdirSync(tmpDir, { recursive: true })
    extractTarball(buf, tmpDir)

    const entryInTmp = join(tmpDir, 'package', spec.binRelPath)
    if (!existsSync(entryInTmp)) {
      throw new Error(
        `installManagedCli: expected entry '${spec.binRelPath}' is missing from ${spec.npmPackage}@${meta.version}`
      )
    }

    if (spec.ensurePackages?.length) {
      const pkgPath = join(tmpDir, 'package', 'package.json')
      if (existsSync(pkgPath)) {
        const patched = ensurePackageJsonDeps(readFileSync(pkgPath, 'utf8'), spec.ensurePackages)
        if (patched.added.length) writeFileSync(pkgPath, patched.json, 'utf8')
      }
    }

    throwIfAborted()
    rmSync(versionDir, { recursive: true, force: true }) // clear any stale prior extraction at this version
    renameSync(tmpDir, versionDir)
    tmpDir = null // ownership transferred to versionDir — nothing left for the catch block to clean up

    const entry = join(versionDir, 'package', spec.binRelPath)
    writeCurrentPointerAtomic(id, { version: meta.version, entry })

    onProgress({ phase: 'done' })
    return { entry, version: meta.version }
  } catch (err) {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* best-effort cleanup — the outer error is what matters to the caller */
      }
    }
    const cancelled = isCancellation(err, signal)
    const message = cancelled ? 'cancelled' : errMsg(err)
    onProgress({ phase: 'error', error: message })
    throw cancelled ? new Error('cancelled') : err instanceof Error ? err : new Error(message)
  }
}

// ─── Reading back an installed CLI ──────────────────────────────────────────────────

/** The currently-installed entry for `id`, or null if never installed / current.json is missing,
 *  malformed, or points at a file that no longer exists on disk. */
export function managedCliEntry(id: ManagedCliId): { entry: string; version: string } | null {
  try {
    const raw = readFileSync(currentJsonPath(id), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CurrentPointer>
    if (typeof parsed.version !== 'string' || typeof parsed.entry !== 'string') return null
    if (!existsSync(parsed.entry)) return null
    return { entry: parsed.entry, version: parsed.version }
  } catch {
    return null
  }
}

/**
 * Detect the Dust CLI Connect just unpacked when current.json is missing or stale.
 * Overlay-68: Settings said "not yet installed" because detect only looked at PATH `dust`
 * (`~/.hermes/node/bin/dust`) and never at userData/managed-cli/dust.
 */
export function findManagedDustEntry(userData?: string): { entry: string; version: string } | null {
  const pointed = ((): { entry: string; version: string } | null => {
    try {
      return managedCliEntry('dust')
    } catch {
      return null
    }
  })()
  if (pointed) return pointed
  let root: string
  try {
    root = userData ? join(userData, 'managed-cli', 'dust') : installRoot('dust')
  } catch {
    return null
  }
  const spec = MANAGED_CLIS.dust
  const pinned = join(root, DUST_CLI_PINNED_VERSION, 'package', spec.binRelPath)
  if (existsSync(pinned)) return { entry: pinned, version: DUST_CLI_PINNED_VERSION }
  try {
    const versions = readdirSync(root).filter((name) => !name.startsWith('.') && name !== 'current.json')
    for (const version of versions.sort().reverse()) {
      const entry = join(root, version, 'package', spec.binRelPath)
      if (existsSync(entry)) return { entry, version }
    }
  } catch {
    /* no managed tree */
  }
  return null
}

/** The { command, args, env } to spawn `id`'s managed CLI, or null if it isn't installed. Runs Electron's
 *  own binary (process.execPath) as the interpreter: ELECTRON_RUN_AS_NODE='1' makes Electron boot as a
 *  plain Node.js runtime (its bundled Node core, currently >=22) instead of Electron/Chromium, so the JS
 *  entry point runs exactly as it would under a system `node` — without the user ever installing one. */
export function managedCliCommand(id: ManagedCliId): { command: string; args: string[]; env: Record<string, string> } | null {
  const found = managedCliEntry(id)
  if (!found) return null
  return {
    command: process.execPath,
    args: [found.entry],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}
