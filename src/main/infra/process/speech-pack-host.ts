import { utilityProcess, type UtilityProcess } from 'electron'

export interface UtilityHostPort {
  on(event: 'message', listener: (message: unknown) => void): unknown
  on(event: 'exit', listener: (code: number | null) => void): unknown
  postMessage(message: Record<string, unknown>): void
  kill(): void
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  stdout?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
}

export type UtilityHostFork = (
  path: string,
  args: string[],
  options: { serviceName: string; stdio: 'pipe' }
) => UtilityHostPort

export interface ManagedUtilityHost {
  readonly host: UtilityHostPort
  readonly didExit: boolean
  stop(timeoutMs: number): Promise<void>
}

interface Owner {
  host: UtilityHostPort | null
  exited: boolean
  stopping: boolean
  exitPromise: Promise<void>
  resolveExit: () => void
}

let owner: Owner | null = null

function defaultFork(path: string, args: string[], options: { serviceName: string; stdio: 'pipe' }): UtilityProcess {
  return utilityProcess.fork(path, args, options)
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
    timer = setTimeout(() => resolve(null), ms)
  })
}

function waitForExit(owner: Owner, ms: number, signal?: AbortSignal): Promise<'exited' | 'timed-out' | 'cancelled'> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: 'exited' | 'timed-out' | 'cancelled'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => finish('cancelled')
    timer = setTimeout(() => finish('timed-out'), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    owner.exitPromise.then(() => finish('exited'))
  })
}

function cancelled(): Error {
  return new Error('Utility host acquisition was cancelled.')
}

/** Owns one utility process slot and releases it only after that exact process reports exit. */
export async function acquireManagedUtilityHost(input: {
  path: string
  args?: string[]
  serviceName: string
  signal?: AbortSignal
  fork?: UtilityHostFork
  waitForExitMs?: number
}): Promise<ManagedUtilityHost> {
  if (input.signal?.aborted) throw cancelled()
  const existing = owner
  if (existing) {
    if (!existing.stopping) throw new Error('A utility host is already running.')
    const released = await waitForExit(existing, input.waitForExitMs ?? 5_000, input.signal)
    if (released === 'cancelled') throw cancelled()
    if (released !== 'exited' || owner) throw new Error('The previous utility host is still stopping.')
  }
  if (input.signal?.aborted) throw cancelled()
  if (owner) throw new Error('A utility host is already running.')

  let resolveExit!: () => void
  const next: Owner = {
    host: null,
    exited: false,
    stopping: false,
    exitPromise: new Promise<void>((resolve) => {
      resolveExit = resolve
    }),
    resolveExit: () => resolveExit()
  }
  // Claim synchronously before invoking the injected/default fork, preventing concurrent starts.
  owner = next
  let host: UtilityHostPort
  try {
    if (input.signal?.aborted) throw cancelled()
    host = (input.fork ?? defaultFork)(input.path, input.args ?? [], {
      serviceName: input.serviceName,
      stdio: 'pipe'
    })
  } catch (error) {
    if (owner === next) owner = null
    next.exited = true
    next.resolveExit()
    throw error
  }
  next.host = host
  host.on('exit', () => {
    if (next.exited) return
    next.exited = true
    if (owner === next) owner = null
    next.resolveExit()
  })

  return {
    host,
    get didExit() {
      return next.exited
    },
    async stop(timeoutMs: number): Promise<void> {
      if (next.exited) return
      next.stopping = true
      try {
        host.kill()
      } catch {
        // A failed kill request does not release ownership; only the matching exit event can do that.
      }
      const stopped = await timeout(next.exitPromise, timeoutMs)
      if (stopped === null || !next.exited) {
        throw new Error('Utility host did not stop within the teardown bound.')
      }
    }
  }
}
