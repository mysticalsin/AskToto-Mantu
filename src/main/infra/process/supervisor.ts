import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { AuditSink } from '../../logger'

export interface SupervisedSpawnResult {
  readonly child: ChildProcess
  readonly supervised: boolean
  readonly waitForUnsupervisedFallback?: () => Promise<void>
  // Present when the wrapper was launched: what the registry must fingerprint for the wrapper process itself.
  readonly wrapperLaunch?: { readonly executable: string; readonly args: readonly string[] }
}

interface SupervisedState {
  current: ChildProcess
  supervised: boolean
  usable: boolean
  // Set once we ask the sidecar to stop, so the wrapper's exit is ours and never triggers the direct fallback.
  stopping: boolean
  fallbackRecorded?: Promise<void>
}

// Exit status of `mac-helper supervise` when its own setup failed and the sidecar was never started.
const SUPERVISE_SETUP_FAILURE_STATUS = 125

const supervisedProcesses = new WeakSet<ChildProcess>()
const supervisedPlatforms = new WeakMap<ChildProcess, NodeJS.Platform>()
const supervisedProcessState = new WeakMap<ChildProcess, SupervisedState>()
type UnsupervisedReason = 'wrapper-spawn-failed' | 'wrapper-setup-failed'
export interface SupervisedSpawnHooks {
  readonly onUnsupervisedFallbackSpawned?: (child: ChildProcess) => Promise<void> | void
}

// The named `supervision` flag: `--supervision=on|off` on argv or METIS_SUPERVISION=on|off in the environment
// (argv wins). METIS_SIDECAR_SUPERVISION=1 is the older spelling of `on` and =0 of `off`. Default is on (macOS
// only); `off` always restores the plain direct spawn.
function supervisionFlag(env: NodeJS.ProcessEnv, argv: readonly string[]): 'on' | 'off' {
  for (const value of ['on', 'off'] as const) {
    if (argv.includes(`--supervision=${value}`) || argv.includes(`supervision=${value}`)) return value
  }
  if (env.METIS_SUPERVISION === 'on' || env.METIS_SUPERVISION === 'off') return env.METIS_SUPERVISION
  if (env.METIS_SIDECAR_SUPERVISION === '1') return 'on'
  if (env.METIS_SIDECAR_SUPERVISION === '0') return 'off'
  return 'on'
}

export function sidecarSupervisionEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  argv: readonly string[] = process.argv
): boolean {
  return platform === 'darwin' && supervisionFlag(env, argv) === 'on'
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
  platform: NodeJS.Platform = process.platform,
  hooks: SupervisedSpawnHooks = {},
  argv: readonly string[] = process.argv
): SupervisedSpawnResult {
  if (!sidecarSupervisionEnabled(env, platform, argv)) {
    return { child: spawn(command, [...args], options), supervised: false }
  }

  const helper = macSupervisorHelperPath()
  if (!existsSync(helper)) {
    audit('sidecar.unsupervised', { name, reason: 'wrapper-missing' })
    return { child: spawn(command, [...args], options), supervised: false }
  }

  try {
    const wrapperArgs = ['supervise', '--parent', String(process.pid), '--', command, ...args]
    const wrapper = spawn(helper, wrapperArgs, options)
    const { child, waitForUnsupervisedFallback } = fallbackCapableSupervisedChild(
      wrapper,
      name,
      command,
      args,
      options,
      audit,
      hooks
    )
    supervisedProcesses.add(child)
    supervisedPlatforms.set(child, platform)
    return {
      child,
      supervised: true,
      waitForUnsupervisedFallback,
      wrapperLaunch: { executable: helper, args: wrapperArgs }
    }
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
  if (state) state.stopping = true
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

export function markSidecarProcessUsable(child: ChildProcess): void {
  const state = supervisedProcessState.get(child)
  if (state) state.usable = true
}

function fallbackCapableSupervisedChild(
  wrapper: ChildProcess,
  name: 'llama-server' | 'fm-serve',
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  audit: AuditSink,
  hooks: SupervisedSpawnHooks
): { child: ChildProcess; waitForUnsupervisedFallback: () => Promise<void> } {
  const proxy = new EventEmitterChildProcess()
  const state: SupervisedState = {
    current: wrapper,
    supervised: true,
    usable: false,
    stopping: false
  }
  supervisedProcessState.set(proxy.child, state)
  const fallbackToDirect = (reason: UnsupervisedReason, error?: string): void => {
    audit('sidecar.unsupervised', {
      name,
      reason,
      ...(error ? { error } : {})
    })
    try {
      const direct = spawn(command, [...args], options)
      state.current = direct
      state.supervised = false
      state.fallbackRecorded = Promise.resolve(hooks.onUnsupervisedFallbackSpawned?.(direct))
      proxy.attach(direct, state)
    } catch (fallbackError) {
      proxy.emitError(fallbackError)
    }
  }
  proxy.attach(wrapper, state, {
    onError: (error) => {
      fallbackToDirect('wrapper-spawn-failed', error instanceof Error ? error.message : String(error))
    },
    onSetupFailure: (code, signal) => {
      fallbackToDirect('wrapper-setup-failed', `code=${code}, signal=${signal}`)
    }
  })
  return {
    child: proxy.child,
    waitForUnsupervisedFallback: () => state.fallbackRecorded ?? Promise.resolve()
  }
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
        if (state) state.stopping = true
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
    state: SupervisedState,
    hooks: {
      onError?: (error: Error) => void
      onSetupFailure?: (code: number | null, signal: NodeJS.Signals | null) => void
    } = {}
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
      // Only the helper's own setup-failure status means the sidecar never started; a supervised sidecar that
      // exits before becoming usable is a normal start failure and must not be respawned unsupervised.
      if (hooks.onSetupFailure && !state.usable && !state.stopping && code === SUPERVISE_SETUP_FAILURE_STATUS) {
        hooks.onSetupFailure(code, signal)
        return
      }
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
