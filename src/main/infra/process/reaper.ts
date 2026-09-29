import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, join, posix, resolve, win32 } from 'node:path'
import type * as childProcess from 'node:child_process'
import type { ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'
import { auditLog, mainLog } from '../../logger'
import { resolveBinaryPath } from '../../llm/local-runtime'
import { WINDOWS_POWERSHELL } from '../../win-security'
import { argsFingerprint, getProcessIdentity, type SidecarRecord } from './registry'

const require = createRequire(import.meta.url)

function execFileAsync(command: string, args: readonly string[], options: ExecFileOptions & { encoding: 'utf8' }): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = require('node:child_process') as typeof childProcess
  return promisify(execFile)(command, [...args], options) as Promise<{ stdout: string; stderr: string }>
}

export interface ProcessIdentity {
  readonly pid: number
  readonly ppid?: number
  readonly pgid?: number
  readonly osStartTime: string
  readonly exeRealpath: string
  readonly args: readonly string[]
}

export interface ReaperAdapters {
  readonly readRegistryRecords: (runDir: string) => SidecarRecord[]
  readonly processInfo: (pid: number) => Promise<ProcessIdentity | null>
  readonly listProcesses: () => Promise<ProcessIdentity[]>
  readonly kill: (pid: number) => void
  readonly audit: (event: 'sidecar.reaped' | 'sidecar.reap.skipped', detail: Record<string, unknown>) => void
  readonly logSkip: (detail: Record<string, unknown>) => void
}

export interface ReaperOptions {
  readonly userData: string
  readonly currentMain: ProcessIdentity
  readonly llamaServerRealpath: string
  readonly adapters?: Partial<ReaperAdapters>
}

type SkipReason =
  | 'corrupt-registry'
  | 'incomplete-entry'
  | 'pid-not-alive'
  | 'start-time-mismatch'
  | 'exe-mismatch'
  | 'args-mismatch'
  | 'pid-mismatch'
  | 'process-info-failed'
  | 'kill-failed'
  | 'ambiguous-entry'

export async function reapBootSidecars(options: ReaperOptions): Promise<void> {
  const adapters = { ...defaultAdapters(), ...options.adapters }
  const runDir = join(options.userData, 'run')
  const records = adapters.readRegistryRecords(runDir)
  await reapRegistryRecords(records, adapters)
  await reapLegacyLlamaOrphans(options, adapters, registeredPids(records))
}

async function reapRegistryRecords(records: SidecarRecord[], adapters: ReaperAdapters): Promise<void> {
  const spawnedRecords = records.filter((record) => record.kind === 'spawned')
  const ambiguousPids = new Set<number>()
  const recordsByPid = new Map<number, SidecarRecord[]>()
  const duplicatePids = new Set<number>()
  const processedDuplicatePids = new Set<number>()
  for (const record of spawnedRecords) {
    if (typeof record.pid !== 'number') continue
    const group = recordsByPid.get(record.pid) ?? []
    group.push(record)
    recordsByPid.set(record.pid, group)
  }
  for (const [pid, group] of recordsByPid) {
    if (group.length <= 1) continue
    if (sameRegisteredIdentity(group)) duplicatePids.add(pid)
    else ambiguousPids.add(pid)
  }
  for (const record of spawnedRecords) {
    if (typeof record.pid === 'number' && ambiguousPids.has(record.pid)) {
      skip(adapters, 'ambiguous-entry', { pid: record.pid, name: record.name })
      continue
    }
    if (typeof record.pid === 'number' && duplicatePids.has(record.pid)) {
      if (processedDuplicatePids.has(record.pid)) continue
      processedDuplicatePids.add(record.pid)
    }
    await reapRegistryRecord(record, adapters)
  }
}

function registeredPids(records: readonly SidecarRecord[]): Set<number> {
  const out = new Set<number>()
  for (const record of records) {
    if (typeof record.pid === 'number') out.add(record.pid)
  }
  return out
}

function sameRegisteredIdentity(records: readonly SidecarRecord[]): boolean {
  const [first] = records
  if (!first) return true
  if ((first as SidecarRecord & { corrupt?: boolean }).corrupt) return false
  return records.every(
    (record) =>
      !(record as SidecarRecord & { corrupt?: boolean }).corrupt &&
      record.name === first.name &&
      record.osStartTime === first.osStartTime &&
      record.exeRealpath === first.exeRealpath &&
      record.argsFingerprint === first.argsFingerprint
  )
}

async function reapRegistryRecord(record: SidecarRecord, adapters: ReaperAdapters): Promise<void> {
  if ((record as SidecarRecord & { corrupt?: boolean }).corrupt) {
    skip(adapters, 'corrupt-registry', { pid: record.pid, name: record.name })
    return
  }
  const incomplete =
    typeof record.pid !== 'number' ||
    !record.osStartTime ||
    !record.exeRealpath ||
    !record.argsFingerprint ||
    !record.name
  if (incomplete) {
    skip(adapters, 'incomplete-entry', { pid: record.pid, name: record.name })
    return
  }
  let live: ProcessIdentity | null
  try {
    live = await adapters.processInfo(record.pid!)
  } catch (error) {
    skip(adapters, 'process-info-failed', { pid: record.pid, name: record.name, error: errorMessage(error) })
    return
  }
  if (!live) {
    skip(adapters, 'pid-not-alive', { pid: record.pid, name: record.name })
    return
  }
  if (live.pid !== record.pid) {
    skip(adapters, 'pid-mismatch', { pid: record.pid, name: record.name })
    return
  }
  if (live.osStartTime !== record.osStartTime) {
    skip(adapters, 'start-time-mismatch', { pid: record.pid, name: record.name })
    return
  }
  if (live.exeRealpath !== record.exeRealpath) {
    skip(adapters, 'exe-mismatch', { pid: record.pid, name: record.name })
    return
  }
  if (!liveArgsMatchFingerprint(live, record.argsFingerprint)) {
    skip(adapters, 'args-mismatch', { pid: record.pid, name: record.name })
    return
  }
  try {
    adapters.kill(record.pid!)
    adapters.audit('sidecar.reaped', { name: record.name, pid: record.pid, reason: 'registry' })
  } catch (error) {
    skip(adapters, 'kill-failed', { pid: record.pid, name: record.name, error: errorMessage(error) })
  }
}

function liveArgsMatchFingerprint(live: ProcessIdentity, expected: string): boolean {
  if (argsFingerprint(live.args) === expected) return true
  if (live.args.length > 0 && argsFingerprint(live.args.slice(1)) === expected) return true
  return false
}

async function reapLegacyLlamaOrphans(options: ReaperOptions, adapters: ReaperAdapters, registryPids: ReadonlySet<number>): Promise<void> {
  const modelRoot = normalizeModelRoot(options.userData)
  const procs = await adapters.listProcesses()
  for (const proc of procs) {
    if (registryPids.has(proc.pid)) continue
    if (proc.exeRealpath !== options.llamaServerRealpath) continue
    if (proc.ppid !== 1) continue
    if (!startedBefore(proc.osStartTime, options.currentMain.osStartTime)) continue
    if (!legacyArgsPointAtUserModel(proc.args, modelRoot)) continue
    try {
      adapters.kill(proc.pid)
      adapters.audit('sidecar.reaped', { name: 'llama-server', pid: proc.pid, reason: 'legacy-orphan' })
    } catch (error) {
      skip(adapters, 'kill-failed', { pid: proc.pid, name: 'llama-server', error: errorMessage(error) })
    }
  }
}

function legacyArgsPointAtUserModel(args: readonly string[], modelRoot: string): boolean {
  const root = normalizeComparableModelPath(modelRoot)
  if (!root) return false
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== '-m') continue
    const modelPath = normalizeComparableModelPath(args[i + 1])
    if (modelPath && modelPath.startsWith(root)) return true
  }
  return false
}

function normalizeModelRoot(userData: string): string {
  const flavor = pathFlavor(userData)
  return (flavor ?? posix).join(userData, 'local-llm')
}

function normalizeComparableModelPath(path: string): string | null {
  const flavor = pathFlavor(path)
  if (!flavor) return null
  return withTrailingSeparator(flavor.normalize(path))
}

function pathFlavor(path: string): typeof posix | typeof win32 | null {
  if (win32.isAbsolute(path) && /^[a-zA-Z]:[\\/]|^\\\\/.test(path)) return win32
  if (posix.isAbsolute(path)) return posix
  return null
}

function startedBefore(candidate: string, reference: string): boolean {
  const candidateMs = Date.parse(candidate)
  const referenceMs = Date.parse(reference)
  return Number.isFinite(candidateMs) && Number.isFinite(referenceMs) && candidateMs < referenceMs
}

function withTrailingSeparator(path: string): string {
  return path.endsWith('/') || path.endsWith('\\') ? path : `${path}/`
}

function skip(adapters: ReaperAdapters, reason: SkipReason, detail: Record<string, unknown>): void {
  const payload = { reason, ...safeDetail(detail) }
  adapters.logSkip(payload)
  adapters.audit('sidecar.reap.skipped', payload)
}

function safeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof detail.name === 'string') out.name = detail.name
  if (typeof detail.pid === 'number') out.pid = detail.pid
  if (typeof detail.error === 'string') out.error = detail.error
  return out
}

export function readRegistryRecords(runDir: string): SidecarRecord[] {
  const records: SidecarRecord[] = []
  let files: string[]
  try {
    files = readdirSync(runDir).filter((f) => /^sidecars-[a-zA-Z0-9-]+\.json$/.test(f))
  } catch {
    return records
  }
  for (const file of files) {
    const path = join(runDir, file)
    let lines: string[]
    try {
      lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    } catch {
      records.push({ kind: 'spawned', sessionId: basename(file), name: '', recordedAt: '', corrupt: true } as SidecarRecord & { corrupt: true })
      continue
    }
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as SidecarRecord)
      } catch {
        records.push({ kind: 'spawned', sessionId: basename(file), name: '', recordedAt: '', corrupt: true } as SidecarRecord & { corrupt: true })
      }
    }
  }
  return records
}

export async function runBootSidecarReaper(userData = app.getPath('userData')): Promise<void> {
  try {
    const currentMain = await getProductionProcessInfo(process.pid)
    const llama = productionLlamaRealpath()
    if (!currentMain || !llama) return
    await reapBootSidecars({ userData, currentMain, llamaServerRealpath: llama })
  } catch (error) {
    mainLog.warn('[sidecar.reaper] boot reaper failed', error)
  }
}

function defaultAdapters(): ReaperAdapters {
  return {
    readRegistryRecords,
    processInfo: getProductionProcessInfo,
    listProcesses: listProductionProcesses,
    kill(pid) {
      process.kill(pid, 'SIGKILL')
    },
    audit(event, detail) {
      auditLog(event, detail)
    },
    logSkip(detail) {
      mainLog.warn('[sidecar.reap.skipped]', detail)
    }
  }
}

async function getProductionProcessInfo(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === 'darwin' || process.platform === 'win32') return getProcessIdentity(pid)
  return getPosixProcessInfo(pid)
}

async function listProductionProcesses(): Promise<ProcessIdentity[]> {
  if (process.platform === 'win32') return listWindowsProcesses()
  return listPosixProcesses()
}

async function getPosixProcessInfo(pid: number): Promise<ProcessIdentity | null> {
  const procs = await listPosixProcesses([pid])
  return procs[0] ?? null
}

async function listPosixProcesses(pids?: readonly number[]): Promise<ProcessIdentity[]> {
  const args = pids?.length
    ? ['-o', 'pid=,ppid=,pgid=,lstart=,command=', '-p', pids.join(',')]
    : ['-axo', 'pid=,ppid=,pgid=,lstart=,command=']
  const { stdout } = await execFileAsync('/bin/ps', args, { encoding: 'utf8', timeout: 5_000 })
  return parsePosixPsListing(stdout, psCandidateFilter(pids))
}

/** A lookup of explicit pids resolves every returned line; a full listing resolves only owned sidecar names. */
function psCandidateFilter(pids?: readonly number[]): (exe: string) => boolean {
  return pids?.length ? () => true : isOwnedProcessName
}

/** Executable names of the sidecars Métis spawns; a full `ps` listing resolves realpaths only for these. */
const OWNED_PROCESS_NAMES = new Set(['llama-server', 'fm-serve', 'ffmpeg', 'metis-mac-helper'])
/** Candidate lines resolved between yields, so a long listing never holds the main loop in one task. */
const PS_YIELD_EVERY = 50

function isOwnedProcessName(exe: string): boolean {
  return OWNED_PROCESS_NAMES.has(posix.basename(exe))
}

/**
 * Parses `ps` output. Only lines whose executable passes `isCandidate` are resolved, each with an async realpath,
 * so a full listing costs no filesystem call for processes Métis does not own. Ownership is still decided by the
 * caller on the resolved realpath, registry identity and args.
 */
async function parsePosixPsListing(
  stdout: string,
  isCandidate: (exe: string) => boolean,
  resolveRealpath: (path: string) => Promise<string> = (path) => realpath(path)
): Promise<ProcessIdentity[]> {
  const out: ProcessIdentity[] = []
  let resolved = 0
  for (const line of stdout.split('\n')) {
    const parsed = parsePosixPsLine(line)
    if (!parsed || !isCandidate(parsed.exe)) continue
    if (resolved > 0 && resolved % PS_YIELD_EVERY === 0) await new Promise<void>((done) => setImmediate(done))
    resolved++
    let exeRealpath: string
    try {
      exeRealpath = await resolveRealpath(parsed.exe)
    } catch {
      continue
    }
    out.push({ pid: parsed.pid, ppid: parsed.ppid, pgid: parsed.pgid, osStartTime: parsed.osStartTime, exeRealpath, args: parsed.args })
  }
  return out
}

function parsePosixPsLine(line: string): (Omit<ProcessIdentity, 'exeRealpath'> & { exe: string }) | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.{24})\s+(.+)$/.exec(line)
  if (!match) return null
  const command = match[5].trim()
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    osStartTime: new Date(match[4]).toISOString(),
    exe: command.split(/\s+/)[0],
    args: splitCommand(command)
  }
}

async function listWindowsProcesses(): Promise<ProcessIdentity[]> {
  const script = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class MetisProcNative { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr hProcess, out long creation, out long exit, out long kernel, out long user); [DllImport("shell32.dll", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr handle); public static string[] SplitCommandLine(string commandLine) { if (String.IsNullOrWhiteSpace(commandLine)) return new string[0]; int argc = 0; IntPtr argv = CommandLineToArgvW(commandLine, out argc); if (argv == IntPtr.Zero) return new string[] { commandLine }; try { string[] args = new string[argc]; for (int i = 0; i < argc; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)) ?? ""; return args; } finally { LocalFree(argv); } } }\'',
    '$items = @()',
    'foreach ($p in Get-Process) {',
    '  try {',
    '    $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)"',
    '    [long]$creation = 0; [long]$exit = 0; [long]$kernel = 0; [long]$user = 0',
    '    if (-not [MetisProcNative]::GetProcessTimes($p.Handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { continue }',
    '    if ([string]::IsNullOrWhiteSpace($p.Path)) { continue }',
    '    $items += @{ pid = [int]$p.Id; ppid = [int]$cim.ParentProcessId; pgid = [int]$p.Id; osStartTime = [DateTime]::FromFileTimeUtc($creation).ToString("o"); exeRealpath = $p.Path; args = @([MetisProcNative]::SplitCommandLine($cim.CommandLine)) }',
    '  } catch { }',
    '}',
    '$items | ConvertTo-Json -Compress'
  ].join('; ')
  const { stdout } = await execFileAsync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true
  })
  const body = stdout.trim()
  if (!body) return []
  const parsed = JSON.parse(body) as ProcessIdentity | ProcessIdentity[]
  const items = Array.isArray(parsed) ? parsed : [parsed]
  return items.filter((item) => typeof item.pid === 'number' && !!item.osStartTime && !!item.exeRealpath)
}

function splitCommand(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(command))) out.push(match[1] ?? match[2] ?? match[3])
  return out
}

function productionLlamaRealpath(): string | null {
  for (const candidate of resolveBinaryPath()) {
    try {
      return realpathSync(candidate.path)
    } catch {
      /* try next candidate */
    }
  }
  return null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const testOnly = {
  argsFingerprint,
  legacyArgsPointAtUserModel,
  liveArgsMatchFingerprint,
  isOwnedProcessName,
  parsePosixPsLine,
  parsePosixPsListing,
  psCandidateFilter,
  startedBefore
}
