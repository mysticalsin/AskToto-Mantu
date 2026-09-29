import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type * as childProcess from 'node:child_process'
import type { ChildProcess, ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import { getProcessIdentity as getMacProcessIdentity } from '../../mac-helper'
import { mainLog } from '../../logger'
import { WINDOWS_POWERSHELL } from '../../win-security'

const require = createRequire(import.meta.url)

function execFileAsync(command: string, args: readonly string[], options: ExecFileOptions & { encoding: 'utf8' }): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = require('node:child_process') as typeof childProcess
  return promisify(execFile)(command, [...args], options) as Promise<{ stdout: string; stderr: string }>
}

export interface SidecarRecord {
  readonly kind: 'intent' | 'spawned'
  readonly sessionId: string
  readonly name: string
  readonly pid?: number
  readonly pgid?: number
  readonly osStartTime?: string
  readonly exeRealpath?: string
  readonly argsFingerprint?: string
  readonly recordedAt: string
}

export interface SidecarRegistry {
  readonly sessionId: string
  readonly path: string
  readonly recordIntent: (name: string, args: readonly string[]) => void
  readonly recordSpawned: (name: string, child: ChildProcess, executable: string, args: readonly string[]) => Promise<void>
  // A sidecar launched through the supervise wrapper: records the wrapper (`wrapper.executable`/`args`) and the
  // real sidecar it spawned as its only child, so the reaper can kill either if the other is gone.
  readonly recordSupervisedSpawned: (
    name: string,
    wrapper: ChildProcess,
    wrapperLaunch: SidecarLaunch,
    sidecarLaunch: SidecarLaunch
  ) => Promise<void>
}

export interface SidecarLaunch {
  readonly executable: string
  readonly args: readonly string[]
}

export interface SidecarRegistryAdapters {
  readonly getIdentity: (pid: number, executable: string) => Promise<ProcessIdentity | null>
  readonly findChildPid: (parentPid: number) => Promise<number | null>
}

export interface ProcessIdentity {
  readonly pid: number
  readonly ppid?: number
  readonly pgid?: number
  readonly osStartTime: string
  readonly exeRealpath: string
  readonly args: readonly string[]
}

let configuredRegistry: SidecarRegistry | null = null

export function argsFingerprint(args: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(args), 'utf8').digest('hex')
}

function appendRecord(path: string, record: SidecarRecord): void {
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
}

const CHILD_LOOKUP_ATTEMPTS = 20
const CHILD_LOOKUP_DELAY_MS = 100

// The helper spawns the sidecar just after it starts, so the child may not exist yet on the first look.
async function findChildPidWithPgrep(parentPid: number): Promise<number | null> {
  for (let attempt = 0; attempt < CHILD_LOOKUP_ATTEMPTS; attempt++) {
    try {
      const { stdout } = await execFileAsync('/usr/bin/pgrep', ['-P', String(parentPid)], {
        encoding: 'utf8',
        timeout: 5_000
      })
      const pid = Number(stdout.trim().split('\n')[0])
      if (Number.isInteger(pid) && pid > 0) return pid
    } catch {
      // pgrep exits 1 while the parent has no child yet.
    }
    await new Promise((resolve) => setTimeout(resolve, CHILD_LOOKUP_DELAY_MS))
  }
  return null
}

export function createSidecarRegistry(
  userData: string,
  sessionId = randomUUID(),
  adapters: SidecarRegistryAdapters = { getIdentity: getProcessIdentity, findChildPid: findChildPidWithPgrep }
): SidecarRegistry {
  const runDir = join(userData, 'run')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const path = join(runDir, `sidecars-${sessionId}.json`)
  async function recordIdentity(name: string, pid: number, executable: string, args: readonly string[]): Promise<void> {
    const identity = await adapters.getIdentity(pid, executable)
    const exeRealpath = safeRealpath(executable)
    if (!identity || !exeRealpath) return
    if (identity.pid !== pid || identity.exeRealpath !== exeRealpath) return
    if (!identityArgsMatchFingerprint(identity.args, argsFingerprint(args))) return
    appendRecord(path, {
      kind: 'spawned',
      sessionId,
      name,
      pid,
      pgid: identity.pgid ?? pid,
      osStartTime: identity.osStartTime,
      exeRealpath,
      argsFingerprint: argsFingerprint(args),
      recordedAt: new Date().toISOString()
    })
  }
  return {
    sessionId,
    path,
    recordIntent(name, args) {
      appendRecord(path, {
        kind: 'intent',
        sessionId,
        name,
        argsFingerprint: argsFingerprint(args),
        recordedAt: new Date().toISOString()
      })
    },
    async recordSpawned(name, child, executable, args) {
      const pid = child.pid
      if (typeof pid !== 'number') return
      await recordIdentity(name, pid, executable, args)
    },
    async recordSupervisedSpawned(name, wrapper, wrapperLaunch, sidecarLaunch) {
      const wrapperPid = wrapper.pid
      if (typeof wrapperPid !== 'number') return
      await recordIdentity(name, wrapperPid, wrapperLaunch.executable, wrapperLaunch.args)
      const sidecarPid = await adapters.findChildPid(wrapperPid)
      if (sidecarPid !== null) await recordIdentity(name, sidecarPid, sidecarLaunch.executable, sidecarLaunch.args)
    }
  }
}

export async function getProcessIdentity(pid: number, executable?: string): Promise<ProcessIdentity | null> {
  if (process.platform === 'darwin') return getMacProcessIdentity(pid)
  if (process.platform === 'win32') return getWindowsProcessIdentity(pid)
  return getPosixProcessIdentity(pid, executable)
}

async function getPosixProcessIdentity(pid: number, executable?: string): Promise<ProcessIdentity | null> {
  let stdout: string
  try {
    const result = await execFileAsync('/bin/ps', ['-o', 'pid=,ppid=,pgid=,lstart=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000
    })
    stdout = result.stdout
  } catch {
    return null
  }
  const parsed = parsePosixPsLine(stdout)
  if (!parsed) return null
  const expected = executable ? safeRealpath(executable) : undefined
  if (expected && parsed.exeRealpath !== expected) return null
  return parsed
}

function parsePosixPsLine(line: string): ProcessIdentity | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.{24})\s+(.+)$/.exec(line.trim())
  if (!match) return null
  const exe = match[5].trim().split(/\s+/)[0]
  const exeRealpath = exe ? safeRealpath(exe) : undefined
  if (!exeRealpath) return null
  const started = new Date(match[4])
  if (Number.isNaN(started.getTime())) return null
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    osStartTime: started.toISOString(),
    exeRealpath,
    args: splitCommand(match[5].trim())
  }
}

async function getWindowsProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const script = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class MetisProcNative { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr hProcess, out long creation, out long exit, out long kernel, out long user); [DllImport("shell32.dll", SetLastError=true)] public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc); [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr handle); public static string[] SplitCommandLine(string commandLine) { if (String.IsNullOrWhiteSpace(commandLine)) return new string[0]; int argc = 0; IntPtr argv = CommandLineToArgvW(commandLine, out argc); if (argv == IntPtr.Zero) return new string[] { commandLine }; try { string[] args = new string[argc]; for (int i = 0; i < argc; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)) ?? ""; return args; } finally { LocalFree(argv); } } }\'',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { exit 0 }',
    `$cim = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    '[long]$creation = 0; [long]$exit = 0; [long]$kernel = 0; [long]$user = 0',
    'if (-not [MetisProcNative]::GetProcessTimes($p.Handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { exit 0 }',
    '$start = [DateTime]::FromFileTimeUtc($creation).ToString("o")',
    '$payload = @{ pid = [int]$p.Id; ppid = [int]$cim.ParentProcessId; pgid = [int]$p.Id; osStartTime = $start; exeRealpath = $p.Path; args = @([MetisProcNative]::SplitCommandLine($cim.CommandLine)) }',
    '$payload | ConvertTo-Json -Compress'
  ].join('; ')
  const { stdout } = await execFileAsync(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true
  })
  if (!stdout.trim()) return null
  const parsed = JSON.parse(stdout) as ProcessIdentity
  return parsed.exeRealpath ? parsed : null
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function identityArgsMatchFingerprint(args: readonly string[], expected: string): boolean {
  if (argsFingerprint(args) === expected) return true
  if (args.length > 0 && argsFingerprint(args.slice(1)) === expected) return true
  return false
}

function splitCommand(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(command))) out.push(match[1] ?? match[2] ?? match[3])
  return out
}

export function configureSidecarRegistry(registry: SidecarRegistry): void {
  configuredRegistry = registry
}

export function activeSidecarRegistry(): SidecarRegistry | null {
  return configuredRegistry
}

export function recordSidecarIntent(name: string, args: readonly string[]): void {
  try {
    configuredRegistry?.recordIntent(name, args)
  } catch (error) {
    mainLog.warn('[sidecar.registry] intent write failed', error)
  }
}

export function recordSidecarSupervisedSpawned(
  name: string,
  wrapper: ChildProcess,
  wrapperLaunch: SidecarLaunch,
  sidecarLaunch: SidecarLaunch
): Promise<void> {
  const registry = configuredRegistry
  if (!registry) return Promise.resolve()
  return registry.recordSupervisedSpawned(name, wrapper, wrapperLaunch, sidecarLaunch).catch((error) => {
    mainLog.warn('[sidecar.registry] supervised spawned write failed', error)
  })
}

export function recordSidecarSpawned(name: string, child: ChildProcess, executable: string, args: readonly string[]): Promise<void> {
  const registry = configuredRegistry
  if (!registry) return Promise.resolve()
  return registry.recordSpawned(name, child, executable, args).catch((error) => {
    mainLog.warn('[sidecar.registry] spawned write failed', error)
  })
}
