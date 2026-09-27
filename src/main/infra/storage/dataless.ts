/**
 * Cloud-placeholder detection: whether a file's bytes are on this device, answered BEFORE anything reads
 * the file. Reading a cloud-only file makes the OS download it, and the read blocks its thread until the
 * provider answers, for minutes when offline.
 *
 * The probes read placeholder metadata only, in a child process, and never open file data:
 *   - macOS: `metis-mac-helper stat-flags` returns each path's st_flags; SF_DATALESS marks a cloud-only
 *     file. Node's fs.Stats has no st_flags, and `blocks === 0` also matches APFS-compressed local files.
 *   - Windows: one PowerShell process returns each path's FILE_ATTRIBUTE_* word; OFFLINE, RECALL_ON_OPEN
 *     and RECALL_ON_DATA_ACCESS mark a placeholder whose data is not local.
 * Both read NUL-separated UTF-8 paths on stdin and answer ONE JSON array: the word per path, in order, or
 * null where that path's metadata query failed.
 *
 * 'unknown' (no probe, a failed probe, or a failed query) means "treat as cloud-only": list and search
 * never read it. This module does no file-system I/O itself; callers pass the stat they already hold.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { auditLog, mainLog } from '../../logger'
import { macStatFlagsSpawnSpec } from '../../mac-helper'
import { WINDOWS_POWERSHELL } from '../../win-security'

/** Whether a file's content is on this device. Handle 'unknown' exactly like 'dataless'. */
export type ContentPresence = 'local' | 'dataless' | 'unknown'

/** The stat fields that identify one version of a file. ctime belongs here because eviction and hydration
 *  change a file's flags or attributes, and so its ctime, while mtime and size stay put. */
export interface FileVersion {
  path: string
  mtimeMs: number
  ctimeMs: number
  size: number
}

/** Reads placeholder metadata (never content) for `paths` and returns one verdict per path, in order.
 *  Resolves null when this device has no probe available; rejects when the probe ran and failed. */
export type PresenceProbe = (paths: readonly string[]) => Promise<readonly ContentPresence[] | null>

export interface DatalessDetector {
  /** Resolves with an entry for every path in `files` and never rejects. Only files whose version is not
   *  cached are probed, all in one batch. */
  classify(files: readonly FileVersion[]): Promise<Map<string, ContentPresence>>
}

/** SF_DATALESS, <sys/stat.h>. */
const SF_DATALESS = 0x4000_0000
/** FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, <winnt.h>. */
const WIN_PLACEHOLDER_ATTRIBUTES = 0x0000_1000 | 0x0004_0000 | 0x0040_0000
/** The helper starts in about 0.1 s (see mac-helper.ts) and stat(2) on a listed file does not wait on the network. */
const MAC_PROBE_TIMEOUT_MS = 5_000
/** powershell.exe cold starts take 0.5-1.9 s on a managed install (see win-security.ts). */
const WIN_PROBE_TIMEOUT_MS = 10_000
/** After a failed probe, misses stay 'unknown' this long without a new attempt, so a broken probe cannot
 *  spawn a process per History open or search keystroke. */
const PROBE_RETRY_MS = 60_000
/** Bounds the cache across folder switches, far above any library measured. Insertion order is eviction order. */
const MAX_CACHED_VERSIONS = 10_000

const AttributeWordsSchema = z.array(z.number().int().min(0).max(0xffff_ffff).nullable())

/** Constant script: paths arrive only on stdin, decoded from raw bytes so the console code page cannot
 *  mangle them. GetAttributes queries metadata and never opens file data. */
const WIN_ATTRIBUTES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$bytes = New-Object System.IO.MemoryStream',
  '[Console]::OpenStandardInput().CopyTo($bytes)',
  '$paths = [Text.Encoding]::UTF8.GetString($bytes.ToArray()).Split([char]0)',
  '$words = foreach ($path in $paths) { try { [string][int][IO.File]::GetAttributes($path) } catch { "null" } }',
  "[Console]::Out.Write('[' + ($words -join ',') + ']')"
].join('\n')

/** Pinned System32 binary and -EncodedCommand, as win-security.ts requires for every PowerShell spawn. */
const WIN_ATTRIBUTES_SPAWN_SPEC = {
  command: WINDOWS_POWERSHELL,
  args: [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(WIN_ATTRIBUTES_SCRIPT, 'utf16le').toString('base64')
  ]
}

const execFileAsync = promisify(execFile)

export function presenceFromStFlags(flags: number | null): ContentPresence {
  if (flags === null) return 'unknown'
  return (flags & SF_DATALESS) === 0 ? 'local' : 'dataless'
}

export function presenceFromWinAttributes(attributes: number | null): ContentPresence {
  if (attributes === null) return 'unknown'
  return (attributes & WIN_PLACEHOLDER_ATTRIBUTES) === 0 ? 'local' : 'dataless'
}

async function runAttributeProbe(
  spec: { command: string; args: string[] } | null,
  paths: readonly string[],
  timeoutMs: number,
  decode: (word: number | null) => ContentPresence
): Promise<ContentPresence[] | null> {
  if (!spec) return null
  const pending = execFileAsync(spec.command, spec.args, {
    encoding: 'utf8',
    // An AbortSignal settles at the deadline even when the child cannot be reaped; execFile's own
    // `timeout` waits for 'close', which such a child never emits.
    signal: AbortSignal.timeout(timeoutMs),
    killSignal: 'SIGKILL',
    windowsHide: true
  })
  // A probe that exits before draining stdin fails through its exit status; the EPIPE this write then
  // raises must not become an unhandled stream error in the main process.
  pending.child.stdin?.on('error', () => {})
  pending.child.stdin?.end(paths.join('\0'))
  const { stdout } = await pending
  return AttributeWordsSchema.parse(JSON.parse(stdout)).map(decode)
}

/** The probe for `platform`. Platforms other than macOS and Windows have no cloud-placeholder mechanism
 *  the app supports, so every file there is local. */
export function presenceProbeFor(platform: NodeJS.Platform): PresenceProbe {
  switch (platform) {
    case 'darwin':
      return (paths) => runAttributeProbe(macStatFlagsSpawnSpec(), paths, MAC_PROBE_TIMEOUT_MS, presenceFromStFlags)
    case 'win32':
      return (paths) => runAttributeProbe(WIN_ATTRIBUTES_SPAWN_SPEC, paths, WIN_PROBE_TIMEOUT_MS, presenceFromWinAttributes)
    default:
      return async (paths) => paths.map((): ContentPresence => 'local')
  }
}

/** A content-free label for a probe failure: the errno or exit code, else the error's class name. */
function failureCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' || typeof code === 'number') return String(code)
  return error instanceof Error ? error.name : typeof error
}

export function createDatalessDetector(probe: PresenceProbe = presenceProbeFor(process.platform)): DatalessDetector {
  const cache = new Map<string, Omit<FileVersion, 'path'> & { presence: 'local' | 'dataless' }>()
  /** performance.now() before which a failed probe is not retried; null while the probe is healthy. */
  let retryAt: number | null = null

  function cachedPresence(file: FileVersion): ContentPresence | undefined {
    const hit = cache.get(file.path)
    if (!hit || hit.mtimeMs !== file.mtimeMs || hit.ctimeMs !== file.ctimeMs || hit.size !== file.size) {
      return undefined
    }
    return hit.presence
  }

  function remember(file: FileVersion, presence: 'local' | 'dataless'): void {
    cache.delete(file.path)
    cache.set(file.path, { mtimeMs: file.mtimeMs, ctimeMs: file.ctimeMs, size: file.size, presence })
    if (cache.size > MAX_CACHED_VERSIONS) {
      const oldest = cache.keys().next()
      if (!oldest.done) cache.delete(oldest.value)
    }
  }

  async function probeBatch(paths: string[]): Promise<readonly ContentPresence[]> {
    if (retryAt !== null && performance.now() < retryAt) return paths.map(() => 'unknown')
    const started = performance.now()
    let failure: { reason: 'unavailable' | 'failed'; code?: string }
    try {
      const verdicts = await probe(paths)
      if (verdicts !== null && verdicts.length === paths.length) {
        retryAt = null
        mainLog.info('[dataless] probed', { files: paths.length, ms: Math.round(performance.now() - started) })
        return verdicts
      }
      failure = { reason: verdicts === null ? 'unavailable' : 'failed' }
    } catch (error) {
      failure = { reason: 'failed', code: failureCode(error) }
    }
    if (retryAt === null) {
      auditLog('storage.dataless_probe_failed', { reason: failure.reason, files: paths.length })
      mainLog.warn('[dataless] probe failed; files treated as cloud-only', failure)
    }
    retryAt = performance.now() + PROBE_RETRY_MS
    return paths.map(() => 'unknown')
  }

  return {
    async classify(files) {
      const verdicts = new Map<string, ContentPresence>()
      const misses: FileVersion[] = []
      for (const file of files) {
        const presence = cachedPresence(file)
        if (presence) verdicts.set(file.path, presence)
        else misses.push(file)
      }
      if (misses.length === 0) return verdicts
      const probed = await probeBatch(misses.map((file) => file.path))
      misses.forEach((file, i) => {
        const presence = probed[i]
        verdicts.set(file.path, presence)
        if (presence !== 'unknown') remember(file, presence)
      })
      return verdicts
    }
  }
}
