import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { AuditSink } from '../../logger'

export interface SupervisedSpawnResult {
  readonly child: ChildProcess
  readonly supervised: boolean
}

const supervisedProcesses = new WeakSet<ChildProcess>()
const supervisedPlatforms = new WeakMap<ChildProcess, NodeJS.Platform>()
const supervisedProcessState = new WeakMap<ChildProcess, { current: ChildProcess; supervised: boolean }>()

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

function joinResourcePath(root: string, ...parts: string[]): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return [root.replace(/[\\/]+$/, ''), ...parts].join(separator)
}

export function macSupervisorHelperPath(resourcesPath = process.resourcesPath): string {
  const packaged = resourcesPath ? joinResourcePath(resourcesPath, 'mac-helper', 'metis-mac-helper') : null
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
    const wrapper = spawn(helper, ['supervise', '--parent', String(process.pid), '--', command, ...args], options)
    const child = fallbackCapableSupervisedChild(wrapper, name, command, args, options, audit)
    supervisedProcesses.add(child)
    supervisedPlatforms.set(child, platform)
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
  const supervisedPlatform = supervisedPlatforms.get(child)
  const state = supervisedProcessState.get(child)
  if (
    supervisedProcesses.has(child) &&
    (state?.supervised ?? true) &&
    supervisedPlatform !== 'win32' &&
    typeof child.pid === 'number'
  ) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Direct, unsupervised children are not guaranteed to be process-group leaders.
    }
  }
  ;(state?.current ?? child).kill(signal)
}

function fallbackCapableSupervisedChild(
  wrapper: ChildProcess,
  name: 'llama-server' | 'fm-serve',
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  audit: AuditSink
): ChildProcess {
  const proxy = new EventEmitterChildProcess()
  const state = { current: wrapper, supervised: true }
  supervisedProcessState.set(proxy.child, state)
  proxy.attach(wrapper, state, {
    onError: (error) => {
      audit('sidecar.unsupervised', {
        name,
        reason: 'wrapper-spawn-failed',
        error: error instanceof Error ? error.message : String(error)
      })
      try {
        const direct = spawn(command, [...args], options)
        state.current = direct
        state.supervised = false
        proxy.attach(direct, state)
      } catch (fallbackError) {
        proxy.emitError(fallbackError)
      }
    }
  })
  return proxy.child
}

class EventEmitterChildProcess {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly child: ChildProcess
  private readonly emitter = new EventEmitter()

  constructor() {
    const self = this
    this.child = {
      stdout: this.stdout,
      stderr: this.stderr,
      stdin: null,
      stdio: [null, this.stdout, this.stderr, null, null],
      get pid() {
        return supervisedProcessState.get(self.child)?.current.pid
      },
      get killed() {
        return supervisedProcessState.get(self.child)?.current.killed ?? false
      },
      kill(signal?: NodeJS.Signals | number) {
        const state = supervisedProcessState.get(self.child)
        return state?.current.kill(signal) ?? false
      },
      on: this.emitter.on.bind(this.emitter),
      once: this.emitter.once.bind(this.emitter),
      off: this.emitter.off.bind(this.emitter),
      removeListener: this.emitter.removeListener.bind(this.emitter),
      emit: this.emitter.emit.bind(this.emitter)
    } as unknown as ChildProcess
  }

  attach(
    proc: ChildProcess,
    state: { current: ChildProcess; supervised: boolean },
    hooks: { onError?: (error: Error) => void } = {}
  ): void {
    proc.stdout?.pipe(this.stdout, { end: false })
    proc.stderr?.pipe(this.stderr, { end: false })
    proc.once('error', (error) => {
      if (state.current !== proc) return
      if (hooks.onError) hooks.onError(error)
      else this.emitError(error)
    })
    proc.once('exit', (code, signal) => {
      if (state.current !== proc) return
      this.stdout.end()
      this.stderr.end()
      this.emitter.emit('exit', code, signal)
      this.emitter.emit('close', code, signal)
    })
  }

  emitError(error: unknown): void {
    this.stdout.end()
    this.stderr.end()
    this.emitter.emit('error', error)
  }
}
