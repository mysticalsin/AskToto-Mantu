import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { getProcessIdentity as getMacProcessIdentity } from '../../mac-helper'
import { mainLog } from '../../logger'

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

export function createSidecarRegistry(userData: string, sessionId = randomUUID()): SidecarRegistry {
  const runDir = join(userData, 'run')
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const path = join(runDir, `sidecars-${sessionId}.json`)
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
      const identity = await getProcessIdentity(pid, executable)
      appendRecord(path, {
        kind: 'spawned',
        sessionId,
        name,
        pid,
        pgid: identity?.pgid ?? pid,
        osStartTime: identity?.osStartTime,
        exeRealpath: identity?.exeRealpath ?? safeRealpath(executable),
        argsFingerprint: argsFingerprint(args),
        recordedAt: new Date().toISOString()
      })
    }
  }
}

export async function getProcessIdentity(pid: number, executable?: string): Promise<ProcessIdentity | null> {
  if (process.platform === 'darwin') return getMacProcessIdentity(pid)
  if (process.platform === 'win32') return getWindowsProcessIdentity(pid)
  if (!executable) return null
  return {
    pid,
    pgid: pid,
    osStartTime: new Date().toISOString(),
    exeRealpath: safeRealpath(executable) ?? executable,
    args: []
  }
}

async function getWindowsProcessIdentity(pid: number): Promise<ProcessIdentity | null> {
  const { execFile } = await import('node:child_process')
  const { WINDOWS_POWERSHELL } = await import('../../win-security')
  const execFileAsync = promisify(execFile)
  const script = [
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class MetisProcTimes { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessTimes(IntPtr hProcess, out long creation, out long exit, out long kernel, out long user); }\'',
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { exit 0 }',
    `$cim = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    '[long]$creation = 0; [long]$exit = 0; [long]$kernel = 0; [long]$user = 0',
    'if (-not [MetisProcTimes]::GetProcessTimes($p.Handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) { exit 0 }',
    '$start = [DateTime]::FromFileTimeUtc($creation).ToString("o")',
    '$payload = @{ pid = [int]$p.Id; ppid = [int]$cim.ParentProcessId; pgid = [int]$p.Id; osStartTime = $start; exeRealpath = $p.Path; args = @($cim.CommandLine) }',
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

export function recordSidecarSpawned(name: string, child: ChildProcess, executable: string, args: readonly string[]): void {
  const registry = configuredRegistry
  if (!registry) return
  void registry.recordSpawned(name, child, executable, args).catch((error) => {
    mainLog.warn('[sidecar.registry] spawned write failed', error)
  })
}
