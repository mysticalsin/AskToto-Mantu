import type { ChildProcess } from 'node:child_process'
import type { RuntimeFeatureLease } from '../features/components/speech-pack/runtime-lease'

export interface LocalRuntimeChildLifecycle {
  readonly exit: Promise<void>
  readonly exited: boolean
  transferLease(lease: RuntimeFeatureLease): void
  confirmNoChild(): void
  stop(stopProcess: (child: ChildProcess) => void): Promise<void>
}

function hasExited(child: ChildProcess): boolean {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  )
}

/** One process owns one exit barrier and, only after start succeeds, one runtime lease. */
export function trackLocalRuntimeChild(
  child: ChildProcess,
  onFailure: (error: unknown) => void
): LocalRuntimeChildLifecycle {
  let resolveExit!: () => void
  let exited = false
  let lease: RuntimeFeatureLease | null = null
  let stopPromise: Promise<void> | null = null
  const exit = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  const confirmExit = (): void => {
    if (exited) return
    exited = true
    const heldLease = lease
    lease = null
    void Promise.resolve()
      .then(() => heldLease?.release())
      .catch(onFailure)
      .finally(resolveExit)
  }

  child.once('exit', confirmExit)
  child.once('error', () => {
    if (child.pid == null) confirmExit()
  })

  return {
    exit,
    get exited() {
      return exited || hasExited(child)
    },
    transferLease(nextLease) {
      if (exited || hasExited(child) || lease) throw new Error('Local runtime child cannot accept a lease.')
      lease = nextLease
    },
    confirmNoChild: confirmExit,
    stop(stopProcess) {
      if (stopPromise) return stopPromise
      stopPromise = (async () => {
        if (!exited && !hasExited(child)) {
          try {
            stopProcess(child)
          } catch (error) {
            onFailure(error)
          }
        }
        if (hasExited(child)) confirmExit()
        await exit
      })()
      return stopPromise
    }
  }
}
