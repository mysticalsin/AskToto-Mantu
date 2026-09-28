import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AuditSink } from '../../logger'

export interface SupervisedSpawnResult {
  readonly child: ChildProcess
  readonly supervised: boolean
}

const supervisedProcesses = new WeakSet<ChildProcess>()

export function sidecarSupervisionEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'darwin' && env.METIS_SIDECAR_SUPERVISION === '1'
}

function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 7; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

export function macSupervisorHelperPath(resourcesPath = process.resourcesPath): string {
  const packaged = resourcesPath ? join(resourcesPath, 'mac-helper', 'metis-mac-helper') : null
  if (packaged && existsSync(packaged)) return packaged
  return join(findRepoRoot(__dirname), 'resources', 'mac-helper', 'metis-mac-helper')
}

export function spawnSidecarProcess(
  name: 'llama-server' | 'fm-serve',
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  audit: AuditSink,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): SupervisedSpawnResult {
  if (!sidecarSupervisionEnabled(env, platform)) {
    return { child: spawn(command, [...args], options), supervised: false }
  }

  const helper = macSupervisorHelperPath()
  if (!existsSync(helper)) {
    audit('sidecar.unsupervised', { name, reason: 'wrapper-missing' })
    return { child: spawn(command, [...args], options), supervised: false }
  }

  try {
    const child = spawn(helper, ['supervise', '--parent', String(process.pid), '--', command, ...args], options)
    supervisedProcesses.add(child)
    return { child, supervised: true }
  } catch (error) {
    audit('sidecar.unsupervised', {
      name,
      reason: 'wrapper-spawn-failed',
      error: error instanceof Error ? error.message : String(error)
    })
    return { child: spawn(command, [...args], options), supervised: false }
  }
}

export function stopSidecarProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (child.killed) return
  if (supervisedProcesses.has(child) && process.platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Direct, unsupervised children are not guaranteed to be process-group leaders.
    }
  }
  child.kill(signal)
}
