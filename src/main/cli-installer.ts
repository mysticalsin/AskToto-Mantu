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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { ensureManagedNode, resolveManagedNode } from './managed-node'
import {
  NPM_MISSING_NODE_ERROR,
  humanizeNpmInstallError,
  npmInstallLooksLikeMissingBinary
} from '@shared/managed-npm'

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
  /** Dust CLI is ESM + node_modules (keytar). Claude/Codex ship a self-contained JS entry. */
  needsNpmInstall?: boolean
}

export type ManagedCliId = ManagedCliSpec['id']

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
    needsNpmInstall: true
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
function registryLatestUrl(npmPackage: string): string {
  return `https://registry.npmjs.org/${npmPackage.replace('/', '%2f')}/latest`
}

async function fetchLatestMeta(npmPackage: string, signal: AbortSignal | undefined): Promise<NpmLatestMeta> {
  const res = await fetch(registryLatestUrl(npmPackage), { signal })
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
    const meta = await fetchLatestMeta(spec.npmPackage, signal)

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

    if (spec.needsNpmInstall) {
      throwIfAborted()
      onProgress({ phase: 'extracting' })
      // Dust CLI's production deps include keytar — need official Node, not Electron-as-node.
      await ensureManagedNode()
      await npmInstallProduction(join(tmpDir, 'package'), signal)
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
    const message = cancelled ? 'cancelled' : humanizeNpmInstallError(err)
    onProgress({ phase: 'error', error: message })
    throw cancelled ? new Error('cancelled') : new Error(message)
  }
}

// ─── Reading back an installed CLI ──────────────────────────────────────────────────

/**
 * True only when `entry` is the real managed script for `id`: an absolute path under this id's
 * install root, ending at the spec's binRelPath, and a non-empty regular file. existsSync alone is
 * not enough — a leftover current.json can point at the install directory (`/tmp`, userData) or an
 * empty stub; resolveBin then treats that as installed, checkCliSession never returns `missing`,
 * and Settings shows "unknown" instead of "not installed".
 */
export function managedEntryIsRunnable(id: ManagedCliId, entry: string): boolean {
  if (!entry || !isAbsolute(entry)) return false
  const root = installRoot(id)
  const rel = relative(root, entry)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false
  const posixEntry = entry.replace(/\\/g, '/')
  if (!posixEntry.endsWith(MANAGED_CLIS[id].binRelPath)) return false
  try {
    const st = statSync(entry)
    if (!st.isFile() || st.size === 0) return false
  } catch {
    return false
  }
  return true
}

/** The currently-installed entry for `id`, or null if never installed / current.json is missing,
 *  malformed, or points at a path that is not a real runnable entry script. */
export function managedCliEntry(id: ManagedCliId): { entry: string; version: string } | null {
  try {
    const raw = readFileSync(currentJsonPath(id), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CurrentPointer>
    if (typeof parsed.version !== 'string' || typeof parsed.entry !== 'string') return null
    if (!managedEntryIsRunnable(id, parsed.entry)) return null
    return { entry: parsed.entry, version: parsed.version }
  } catch {
    return null
  }
}

/** The { command, args, env } to spawn `id`'s managed CLI, or null if it isn't installed. Runs Electron's
 *  own binary (process.execPath) as the interpreter: ELECTRON_RUN_AS_NODE='1' makes Electron boot as a
 *  plain Node.js runtime (its bundled Node core, currently >=22) instead of Electron/Chromium, so the JS
 *  entry point runs exactly as it would under a system `node` — without the user ever installing one.
 *  Dust uses a vendored portable Node when present so keytar's native addon can load. */
export function managedCliCommand(id: ManagedCliId): { command: string; args: string[]; env: Record<string, string> } | null {
  const found = managedCliEntry(id)
  if (!found) return null
  if (id === 'dust') {
    const portable = resolveManagedNode()
    if (portable) {
      return { command: portable.node, args: [found.entry], env: {} }
    }
  }
  return {
    command: process.execPath,
    args: [found.entry],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

const NPM_INSTALL_ARGS = ['install', '--omit=dev', '--no-fund', '--no-audit'] as const

export class ManagedNpmMissingError extends Error {
  constructor(message: string = NPM_MISSING_NODE_ERROR) {
    super(message)
    this.name = 'ManagedNpmMissingError'
  }
}

const SPAWN_ENV_ALLOW = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS'
])

/** Drop secrets from the parent env. npm only needs a short OS allow-list. */
export function sanitizedSpawnEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (!v) continue
    if (SPAWN_ENV_ALLOW.has(k) || SPAWN_ENV_ALLOW.has(k.toUpperCase())) out[k] = v
  }
  return out
}

/** Official Node: win32 `node.exe` sits next to `node_modules/npm`; darwin/linux `bin/node` uses `../lib`. */
export function resolveNpmCliJs(
  nodePath: string,
  exists: (p: string) => boolean = existsSync
): string | null {
  const dir = dirname(nodePath)
  const parent = dirname(dir)
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(parent, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(parent, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ]
  return candidates.find((p) => exists(p)) ?? null
}

function withNodeOnPath(env: Record<string, string>, nodePath: string): Record<string, string> {
  const dir = dirname(nodePath)
  const existing = env.PATH || env.Path || ''
  const next = existing ? `${dir}${delimiter}${existing}` : dir
  env.PATH = next
  if (process.platform === 'win32') env.Path = next
  return env
}

/**
 * Always spawn the Node binary + npm-cli.js. Never the `bin/npm` shebang (#!/usr/bin/env node)
 * and never a PATH `npm`. Electron GUI PATH has no node: that was exit 127.
 */
export function planNpmInstallSpawn(input: {
  portableNode: string | null
  execPath: string
  exists?: (p: string) => boolean
}): { command: string; args: string[]; env: Record<string, string> } {
  const exists = input.exists ?? existsSync
  if (input.portableNode && exists(input.portableNode)) {
    const npmCli = resolveNpmCliJs(input.portableNode, exists)
    if (!npmCli) throw new ManagedNpmMissingError()
    return { command: input.portableNode, args: [npmCli, ...NPM_INSTALL_ARGS], env: {} }
  }
  const npmCli = resolveNpmCliJs(input.execPath, exists)
  if (!npmCli) throw new ManagedNpmMissingError()
  return { command: input.execPath, args: [npmCli, ...NPM_INSTALL_ARGS], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

export function npmInstallProductionSpawn(): { command: string; args: string[]; env: Record<string, string> } {
  const portable = resolveManagedNode()
  return planNpmInstallSpawn({
    portableNode: portable?.node ?? null,
    execPath: process.execPath
  })
}

/** Local `npm install --omit=dev` inside the extracted package — not `npm i -g`, not a system Node. */
export function npmInstallProduction(packageDir: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let spec: { command: string; args: string[]; env: Record<string, string> }
    try {
      spec = npmInstallProductionSpawn()
    } catch (err) {
      reject(err instanceof Error ? err : new ManagedNpmMissingError())
      return
    }
    const env = withNodeOnPath({ ...sanitizedSpawnEnv(), CI: '1', ...spec.env }, spec.command)
    const child = spawn(spec.command, spec.args, {
      cwd: packageDir,
      env,
      windowsHide: true,
      stdio: 'ignore'
    })
    const onAbort = (): void => {
      child.kill('SIGTERM')
      reject(new CliInstallAbortError())
    }
    signal?.addEventListener('abort', onAbort)
    child.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort)
      reject(
        npmInstallLooksLikeMissingBinary(null, err)
          ? new Error(humanizeNpmInstallError(err))
          : err
      )
    })
    child.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) {
        reject(new CliInstallAbortError())
        return
      }
      if (code !== 0) {
        const raw = `npm install --omit=dev failed in ${packageDir} (exit ${code})`
        reject(new Error(npmInstallLooksLikeMissingBinary(code) ? humanizeNpmInstallError(new Error(raw)) : raw))
        return
      }
      resolve()
    })
  })
}
