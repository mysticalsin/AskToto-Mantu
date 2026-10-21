/**
 * Async dispatch-time helpers for the Receipt Mode brain context.
 *
 * The record/source proofs read files through descriptors (infra/storage/stable-read.ts), so they are
 * asynchronous. Main's ask handler is otherwise synchronous from the IPC message to the stream registration,
 * which means a user cancel could never arrive "before" the stream existed. `hold` keeps that guarantee while
 * a proof is in flight: it registers an abort entry that records a cancel, and the caller checks it once the
 * proof settles. Without a `ready` envelope nothing is awaited and dispatch stays synchronous.
 */
import type { Settings } from '@shared/ipc'
import { areBrainContextRecordsCurrent, areBrainContextSourcesCurrent } from './context'
import { brainContextForProvider, isBrainContextEnvelopeCurrent, staleBrainContextEnvelope } from './context-envelope'
import type { BrainContextEnvelope, BrainContextOwner } from './context-envelope'

/** Fresh proof that every entity record and meeting source behind a `ready` envelope still matches disk. */
export async function brainContextFilesCurrent(
  getSettings: () => Settings,
  envelope: BrainContextEnvelope
): Promise<boolean> {
  const settings = getSettings()
  return (
    (await areBrainContextRecordsCurrent(settings, envelope.recordFingerprints)) &&
    (await areBrainContextSourcesCurrent(settings, envelope.sourceReferences))
  )
}

interface CancelRegistry {
  set(id: string, entry: { abort: () => void }): unknown
  get(id: string): { abort: () => void } | undefined
  delete(id: string): unknown
}

/**
 * Make a pending async step cancellable. Without a race, the ask's stream-registry entry becomes a hold;
 * with a hedge race, the hold joins the race's cleanups (the combined abort registration already exists).
 * `release()` removes the hold and returns true when the ask was cancelled meanwhile.
 */
export function holdForCancel(
  streams: CancelRegistry,
  id: string,
  race?: { addCleanup(fn: () => void): void }
): { release: () => boolean } {
  let cancelled = false
  const hold = {
    abort: (): void => {
      cancelled = true
    }
  }
  if (race) race.addCleanup(hold.abort)
  else streams.set(id, hold)
  return {
    release: () => {
      if (!race && streams.get(id) === hold) streams.delete(id)
      return cancelled
    }
  }
}

export interface BrainContextDispatchDeps {
  getSettings: () => Settings
  currentOwner: (settings: Settings) => BrainContextOwner
  /** The provider request whose main-only `brainContext` is refreshed. */
  req: { id: string; brainContext?: string }
  streams: CancelRegistry
  onError: (err: unknown) => void
}

/** Owns one ask's brain-context envelope and re-proves it before every provider dispatch. */
export function createBrainContextDispatch(deps: BrainContextDispatchDeps) {
  let envelope: BrainContextEnvelope | undefined

  // The owner comparison and the request update are synchronous and run last, in the same tick as the
  // dispatch that follows; only the file proofs (`filesCurrent`) are awaited beforehand.
  const apply = (filesCurrent: boolean): void => {
    if (!envelope) {
      deps.req.brainContext = undefined
      return
    }
    try {
      const current = deps.currentOwner(deps.getSettings())
      if (
        (envelope.status === 'ready' || envelope.status === 'empty') &&
        (!isBrainContextEnvelopeCurrent(envelope, current) || (envelope.status === 'ready' && !filesCurrent))
      ) {
        envelope = staleBrainContextEnvelope(envelope)
      }
      deps.req.brainContext = brainContextForProvider(envelope, current)
    } catch {
      envelope = staleBrainContextEnvelope(envelope)
      deps.req.brainContext = undefined
    }
  }

  /** Synchronous (undefined) unless a ready envelope needs its entity/source files re-proved. */
  const refresh = (): void | Promise<void> => {
    const pending = envelope
    if (pending?.status !== 'ready') return apply(true)
    return brainContextFilesCurrent(deps.getSettings, pending).then(apply, () => apply(false))
  }

  return {
    set: (next: BrainContextEnvelope): void => {
      envelope = next
    },
    hold: (race?: { addCleanup(fn: () => void): void }) => holdForCancel(deps.streams, deps.req.id, race),
    refresh,
    /** Refresh, then run `dispatch`; skipped when the ask was cancelled while the proof was in flight. */
    dispatch: (race: { addCleanup(fn: () => void): void } | undefined, dispatch: () => void): void => {
      const refreshing = refresh()
      if (!refreshing) return dispatch()
      const hold = holdForCancel(deps.streams, deps.req.id, race)
      void refreshing
        .then(() => {
          if (!hold.release()) dispatch()
        })
        .catch(deps.onError)
    }
  }
}
