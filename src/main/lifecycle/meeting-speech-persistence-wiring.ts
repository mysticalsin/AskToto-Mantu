import { access } from 'node:fs/promises'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import { configureMeetingSpeechPersistence, getMeetingSpeechLimits } from '../features/meetings/meeting-speech'
import { installMeetingSpeechPolicy, MEETING_SPEECH_WORKER_BOUNDS } from '../features/meetings/meeting-speech-policy'
import {
  createMeetingSpeechPersistenceService,
  defaultMeetingSpeechWorkerEntry,
  type MeetingSpeechPersistenceService,
  type MeetingSpeechWorkerFactory
} from '../infra/process/meeting-speech-host'
import type { MeetingSpeechFailureCode } from '../infra/process/meeting-speech-protocol'

/** Three worker failures inside this window turn the worker off until the app is relaunched. */
export const MEETING_SPEECH_BREAKER_FAILURES = 3
export const MEETING_SPEECH_BREAKER_WINDOW_MS = 10 * 60 * 1000

export type MeetingSpeechDegradedReason = 'worker-failures' | 'entry-missing' | 'invalidate-failed'

export interface MeetingSpeechBootstrapDeps {
  /** Reads the `meetingSpeechWorker` kill switch (managed-policy lockable). Evaluated on every operation. */
  readWorkerEnabled(): boolean
  /** Auth session generation; a change makes in-flight worker results stale (they re-run inline). */
  authGeneration?(): number
  /** Metadata-only audit sink. Never receives transcript content. */
  audit(event: 'meeting.speech.worker.degraded', record: Record<string, unknown>): void
  /** Registers the will-quit disposal. */
  onWillQuit?(listener: () => void): void
  /** Test seams: a fake worker, its entry path, and the clock the breaker window uses. */
  workerFactory?: MeetingSpeechWorkerFactory
  entryPath?: string
  entryExists?(path: string): Promise<boolean>
  now?(): number
}

export interface MeetingSpeechBootstrap {
  /** Cancels pending worker requests and stops the worker; the next request starts a fresh one. */
  invalidate(): Promise<void>
  /** Stops the worker and unconfigures the service; everything runs inline afterwards. */
  dispose(): Promise<void>
  /** 'off': kill switch off. 'idle': enabled, no worker started yet. 'running': worker started. 'tripped': breaker or load failure. */
  state(): 'off' | 'idle' | 'running' | 'tripped'
}

function named(code: MeetingSpeechFailureCode): Error {
  const error = new Error(`Speech persistence unavailable (${code}).`)
  error.name = code
  return error
}

let active: MeetingSpeechBootstrap | undefined

/**
 * The one production entry for meeting speech: installs the trusted policy (budget + read cap), then configures a
 * persistence facade over the isolated worker. The worker is an optimisation, never a dependency:
 *  - kill switch off, breaker tripped, entry missing, construction failure, crash, queue full or cancel all reject
 *    with a fallback-class code and the async wrappers re-run the same codec inline (`meeting-speech.ts`);
 *  - no service is constructed (and no thread started) until the first operation with the switch on;
 *  - whether the worker thread loads under the V8-bytecode build and from app.asar is UNPROVEN, so a load failure
 *    must only ever cost a fallback and one metadata-only audit record, never a lost save.
 */
export function bootstrapMeetingSpeech(deps: MeetingSpeechBootstrapDeps): MeetingSpeechBootstrap {
  installMeetingSpeechPolicy()
  void active?.dispose().catch(() => undefined)

  const now = deps.now ?? Date.now
  const entryPath = deps.entryPath ?? defaultMeetingSpeechWorkerEntry()
  const entryExists = deps.entryExists ?? ((path: string) => access(path).then(() => true, () => false))
  let inner: MeetingSpeechPersistenceService | null = null
  let tripped = false
  let disposed = false
  let failures: number[] = []
  let boundAuthGeneration = deps.authGeneration?.()

  const enabled = (): boolean => {
    try {
      return deps.readWorkerEnabled()
    } catch {
      return false
    }
  }

  const stopInner = (): void => {
    const service = inner
    inner = null
    void service?.dispose().catch(() => undefined)
  }

  const trip = (reason: MeetingSpeechDegradedReason): void => {
    if (tripped) return
    tripped = true
    stopInner()
    // Persistence goes back to "not configured": every wrapper runs inline and legacy reads take the sync path.
    if (!disposed) configureMeetingSpeechPersistence(undefined)
    try {
      deps.audit('meeting.speech.worker.degraded', {
        reason,
        failures: failures.length,
        windowMs: MEETING_SPEECH_BREAKER_WINDOW_MS
      })
    } catch {
      /* auditing never changes the outcome */
    }
  }

  const noteFailure = (): void => {
    const at = now()
    failures = failures.filter((time) => at - time < MEETING_SPEECH_BREAKER_WINDOW_MS)
    failures.push(at)
    if (failures.length >= MEETING_SPEECH_BREAKER_FAILURES) trip('worker-failures')
  }

  const acquire = (): MeetingSpeechPersistenceService | undefined => {
    if (disposed || tripped) return undefined
    if (!enabled()) {
      stopInner()
      return undefined
    }
    if (inner) return inner
    inner = createMeetingSpeechPersistenceService({
      readLimits: getMeetingSpeechLimits,
      readBounds: () => MEETING_SPEECH_WORKER_BOUNDS,
      isCurrent: () => !disposed && (deps.authGeneration ? deps.authGeneration() === boundAuthGeneration : true),
      ...(deps.workerFactory ? { workerFactory: deps.workerFactory } : {}),
      entryPath
    })
    return inner
  }

  const call = <T>(operation: (service: MeetingSpeechPersistenceService) => Promise<T>): Promise<T> => {
    const service = acquire()
    if (!service) return Promise.reject(named('UNCONFIGURED'))
    let pending: Promise<T>
    try {
      pending = operation(service)
    } catch {
      noteFailure()
      return Promise.reject(named('WORKER_FAILED'))
    }
    return pending.catch((error: unknown) => {
      if (error instanceof Error && error.name === 'WORKER_FAILED') noteFailure()
      throw error
    })
  }

  const facade: MeetingSpeechPersistenceService = {
    reportTiming: () => undefined,
    readLimitBytes: () => MEETING_SPEECH_WORKER_BOUNDS.maxInputBytes,
    render: (lines) => call((service) => service.render(lines)),
    decode: (text) => call((service) => service.decode(text)),
    rewrite: (text, lines) => call((service) => service.rewrite(text, lines)),
    project: (text) => call((service) => service.project(text)),
    encryptEnvelopeV2: (content, contentKey, iv, kLocal, kEscrow) =>
      call((service) => service.encryptEnvelopeV2(content, contentKey, iv, kLocal, kEscrow)),
    decryptEnvelopeV2: (envelopeJson, contentKey, kLocal) =>
      call((service) => service.decryptEnvelopeV2(envelopeJson, contentKey, kLocal)),
    rewrapEnvelopeV2: (envelopeJson, kLocal) => call((service) => service.rewrapEnvelopeV2(envelopeJson, kLocal)),
    canonicalizeIncrementalRecord: (recordJson, binding) =>
      call((service) => service.canonicalizeIncrementalRecord(recordJson, binding)),
    invalidateCurrent: () => bootstrap.invalidate(),
    dispose: () => bootstrap.dispose()
  }

  const bootstrap: MeetingSpeechBootstrap = {
    async invalidate() {
      boundAuthGeneration = deps.authGeneration?.()
      const service = inner
      if (!service) return
      try {
        await service.invalidateCurrent()
      } catch {
        // The worker would not stop in time: do not keep dispatching to it.
        noteFailure()
        trip('invalidate-failed')
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      if (active === bootstrap) active = undefined
      configureMeetingSpeechPersistence(undefined)
      const service = inner
      inner = null
      await service?.dispose().catch(() => undefined)
    },
    state() {
      if (tripped) return 'tripped'
      if (!enabled()) return 'off'
      return inner ? 'running' : 'idle'
    }
  }

  active = bootstrap
  configureMeetingSpeechPersistence(facade)
  // A build that does not ship the worker entry can never start one: say so once, up front, instead of paying three
  // failed attempts first. (Whether an entry that exists still loads under bytecode/asar is only learned by trying;
  // that is the breaker's job.)
  if (!deps.workerFactory)
    void entryExists(entryPath).then((exists) => {
      if (!exists) trip('entry-missing')
    })
  deps.onWillQuit?.(() => {
    void bootstrap.dispose().catch(() => undefined)
  })
  return bootstrap
}

/** Stops the worker when the owner session that may have queued its work is revoked or the auth session changes. */
export function bindMeetingSpeechInvalidation(
  ownerSession: { onRevoked(cb: (ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void): () => void },
  speech: Pick<MeetingSpeechBootstrap, 'invalidate'>
): () => void {
  return ownerSession.onRevoked(() => {
    void speech.invalidate().catch(() => undefined)
  })
}
