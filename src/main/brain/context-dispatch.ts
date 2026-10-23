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
import { contextRecord, quoteAsData } from '@shared/context-authority'
import { redactSecrets } from '@shared/redact'
import type { ContextManifestEntry } from '@shared/context-manifest'
import { areBrainContextRecordsCurrent, areBrainContextSourcesCurrent } from './context'
import { brainContextForProvider, isBrainContextEnvelopeCurrent, staleBrainContextEnvelope } from './context-envelope'
import type { BrainContextEnvelope, BrainContextOwner } from './context-envelope'
import { MemoryServerRecordSchema, type MemoryServerRecord, type MemoryServerResult } from '../memory-server/contract'
import { memoryServerClientEnabled, recallMemoryForCurrentOwner } from '../memory-server/client'

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
  req: { id: string; prompt?: string; transcript?: string; brainContext?: string }
  streams: CancelRegistry
  onError: (err: unknown) => void
  /** The ask's conversation-context gate (G13): checked at every provider dispatch, before anything is sent. */
  gate?: { refusal(): string | null }
  /** Told once, with the gate's message, when the gate refuses; the ask is then cancelled. */
  onRefused?: (message: string) => void
  /** G46: exactly the recalled memory records attached on this dispatch, with content-free provenance. */
  onApplied?: (brainContext: string | undefined, sources?: readonly ContextManifestEntry[]) => void
  /** Test seam for a deterministic contract adapter; production calls the Main-configured client above. */
  memoryServer?: { recall(query: string): Promise<MemoryServerResult<MemoryServerRecord[]>> }
}

/** Owns one ask's brain-context envelope and re-proves it before every provider dispatch. */
export function createBrainContextDispatch(deps: BrainContextDispatchDeps) {
  let envelope: BrainContextEnvelope | undefined
  let refused = false

  /** True when the conversation context this ask was built from is no longer in force. Reports once and aborts. */
  const refusedByGate = (): boolean => {
    const message = deps.gate?.refusal()
    if (!message) return false
    if (!refused) {
      refused = true
      deps.streams.get(deps.req.id)?.abort()
      deps.streams.delete(deps.req.id)
      deps.onRefused?.(message)
    }
    return true
  }

  // Local owner comparison and the request update stay in the same tick as dispatch. When the owner-configured
  // server adapter is enabled, its ACL-checked recall completes first and the owner is checked again before use.
  const applyLocal = (filesCurrent: boolean): string | undefined => {
    if (!envelope) {
      deps.req.brainContext = undefined
      return undefined
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
    return deps.req.brainContext
  }

  const ownerStillCurrent = (before: BrainContextOwner): boolean => {
    try {
      const after = deps.currentOwner(deps.getSettings())
      return (
        before.authSessionGeneration === after.authSessionGeneration &&
        before.contextRevision === after.contextRevision &&
        before.brainRevision === after.brainRevision &&
        before.profileKey === after.profileKey
      )
    } catch {
      return false
    }
  }

  const renderServerRecords = (
    records: readonly MemoryServerRecord[],
    availableChars: number
  ): { block: string | undefined; sources: ContextManifestEntry[] } => {
    const blocks: string[] = []
    const bytesByOrigin = new Map<'connector' | 'document', number>()
    let remaining = availableChars
    for (const candidate of records.slice(0, 32)) {
      const parsed = MemoryServerRecordSchema.safeParse(candidate)
      if (!parsed.success) continue
      const record = parsed.data
      const block = quoteAsData(contextRecord(record.origin, record.text), `${record.origin} memory`)
      const bytes = Buffer.byteLength(block, 'utf8')
      if (bytes > remaining) continue
      blocks.push(block)
      remaining -= bytes
      bytesByOrigin.set(record.origin, (bytesByOrigin.get(record.origin) ?? 0) + bytes)
    }
    const sources: ContextManifestEntry[] = [...bytesByOrigin].map(([origin, bytes]) => ({
      origin,
      authority: 'data',
      sourceId: `memory-${origin}`,
      bytes,
      via: 'ask'
    }))
    return { block: blocks.length ? blocks.join('\n') : undefined, sources }
  }

  const appliedSources = (
    local: string | undefined,
    remote: readonly ContextManifestEntry[]
  ): ContextManifestEntry[] => {
    const sources: ContextManifestEntry[] = []
    if (local) {
      sources.push({
        origin: 'document',
        authority: 'data',
        sourceId: 'memory-document',
        bytes: Buffer.byteLength(local, 'utf8'),
        via: 'ask'
      })
    }
    sources.push(...remote)
    return sources
  }

  const apply = (filesCurrent: boolean): void | Promise<void> => {
    const serverEnabled = deps.memoryServer !== undefined || memoryServerClientEnabled()
    // Only the owner's own question leaves the device as a recall query, secrets redacted. The live transcript (meeting
    // content) never does: it stays local unless a later owner decision says otherwise.
    const query = redactSecrets(deps.req.prompt ?? '')
      .trim()
      .slice(0, 4_000)
    if (!serverEnabled || !query) {
      const local = applyLocal(filesCurrent)
      deps.onApplied?.(local, appliedSources(local, []))
      return
    }

    let ownerBefore: BrainContextOwner
    try {
      ownerBefore = deps.currentOwner(deps.getSettings())
    } catch {
      const local = applyLocal(filesCurrent)
      deps.onApplied?.(local, appliedSources(local, []))
      return
    }
    const recall = deps.memoryServer?.recall ?? recallMemoryForCurrentOwner
    return recall(query)
      .catch((err): MemoryServerResult<MemoryServerRecord[]> => {
        deps.onError(err)
        return { status: 'unavailable' }
      })
      .then((result) => {
        const local = applyLocal(filesCurrent)
        const remainingChars = Math.max(0, 8_000 - (local?.length ?? 0))
        const remote =
          ownerStillCurrent(ownerBefore) && result.status === 'found'
            ? renderServerRecords(result.value, remainingChars)
            : { block: undefined, sources: [] }
        const parts = [local, remote.block].filter((part): part is string => !!part)
        deps.req.brainContext = parts.length ? parts.join('\n\n') : undefined
        deps.onApplied?.(deps.req.brainContext, appliedSources(local, remote.sources))
      })
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
      if (refusedByGate()) return
      const refreshing = refresh()
      if (!refreshing) return dispatch()
      const hold = holdForCancel(deps.streams, deps.req.id, race)
      void refreshing
        .then(() => {
          if (!hold.release() && !refusedByGate()) dispatch()
        })
        .catch(deps.onError)
    }
  }
}
