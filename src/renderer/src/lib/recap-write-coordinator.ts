import type { RecapStatus } from '@shared/recap-status'

export function nextMeetingStart(previous: number, now = Date.now()): number {
  return Math.max(now, previous + 1)
}

export function beginOwnedMeetingExit<T>(cancel: () => T, persist: (snapshot: T) => void): T {
  const snapshot = cancel()
  persist(snapshot)
  return snapshot
}

export function retireRecapWriteKeys(keys: Set<string>, ownerId: string): void {
  const prefix = `${ownerId}\u0000`
  for (const key of keys) {
    if (key.startsWith(prefix)) keys.delete(key)
  }
}

/** Meeting persistence APIs resolve files by basename inside the configured meetings folder. Normalize
 * only the in-memory ordering identity; callers still pass their original absolute/basename IPC value. */
export function recapFileIdentity(file: string): string {
  const normalized = file.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export type RecapWriteOutcome<T> =
  | { status: 'current'; value: T }
  | { status: 'current'; error: unknown }
  | { status: 'superseded' }

/**
 * Renderer-session ordering boundary for generated recap writes. Work is serialized per saved file, not
 * globally: a newer generation waits for an already-started older write and therefore lands last. The
 * older promise still settles, but is labelled superseded so its UI continuation cannot paint or release
 * state now owned by the newer run.
 */
export class RecapWriteCoordinator {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly latest = new Map<string, symbol>()

  write<T>(file: string, runId: string, operation: () => Promise<T>): Promise<RecapWriteOutcome<T>> {
    const identity = recapFileIdentity(file)
    const token = Symbol(runId)
    this.latest.set(identity, token)
    const before = this.tails.get(identity) ?? Promise.resolve()
    const result = before.then(async (): Promise<RecapWriteOutcome<T>> => {
      try {
        const value = await operation()
        return this.latest.get(identity) === token
          ? { status: 'current', value }
          : { status: 'superseded' }
      } catch (error) {
        return this.latest.get(identity) === token
          ? { status: 'current', error }
          : { status: 'superseded' }
      }
    })
    const tail = result.then(() => undefined)
    this.tails.set(identity, tail)
    void tail.then(() => {
      if (this.tails.get(identity) === tail) this.tails.delete(identity)
      if (this.latest.get(identity) === token) this.latest.delete(identity)
    })
    return result
  }
}

/** Owner-scoped in-flight gate for transcript creation. Different meetings may overlap during a rapid
 * restart, but a late completion may publish state only while its token still owns the current meeting. */
export class OwnedOperationGate {
  private readonly active = new Map<string, symbol>()

  start(ownerId: string): symbol | null {
    if (this.active.has(ownerId)) return null
    const token = Symbol(ownerId)
    this.active.set(ownerId, token)
    return token
  }

  isActive(ownerId: string): boolean {
    return this.active.has(ownerId)
  }

  mayPublish(ownerId: string, token: symbol, currentOwnerId: string): boolean {
    return ownerId === currentOwnerId && this.active.get(ownerId) === token
  }

  finish(ownerId: string, token: symbol): void {
    if (this.active.get(ownerId) === token) this.active.delete(ownerId)
  }

  async run<T>(
    ownerId: string,
    currentOwnerId: () => string,
    operation: () => Promise<T>
  ): Promise<
    | { status: 'busy' }
    | { status: 'current'; value: T }
    | { status: 'current'; error: unknown }
    | { status: 'stale'; value: T }
    | { status: 'stale'; error: unknown }
  > {
    const token = this.start(ownerId)
    if (!token) return { status: 'busy' }
    try {
      const value = await operation()
      return this.mayPublish(ownerId, token, currentOwnerId())
        ? { status: 'current', value }
        : { status: 'stale', value }
    } catch (error) {
      return this.mayPublish(ownerId, token, currentOwnerId())
        ? { status: 'current', error }
        : { status: 'stale', error }
    } finally {
      this.finish(ownerId, token)
    }
  }
}

export async function persistRecapOnExit<TCreate, TUpdate>(args: {
  action: { runId: string; text: string; recapStatus: RecapStatus } | null
  path: Promise<string | null>
  isPersisted: () => boolean
  markPersisted: () => void
  create: (text: string, recapStatus: RecapStatus | undefined) => Promise<TCreate>
  update: (path: string, text: string, recapStatus: RecapStatus) => Promise<TUpdate>
  coordinator: RecapWriteCoordinator
}): Promise<
  | { kind: 'unchanged'; path: string }
  | { kind: 'updated'; path: string; outcome: RecapWriteOutcome<TUpdate> }
  | { kind: 'created'; value: TCreate }
> {
  const path = await args.path
  if (!path) {
    return {
      kind: 'created',
      value: await args.create(args.action?.text ?? '', args.action?.recapStatus)
    }
  }
  if (!args.action || args.isPersisted()) return { kind: 'unchanged', path }
  args.markPersisted()
  const outcome = await args.coordinator.write(path, args.action.runId, () =>
    args.update(path, args.action!.text, args.action!.recapStatus)
  )
  return { kind: 'updated', path, outcome }
}
