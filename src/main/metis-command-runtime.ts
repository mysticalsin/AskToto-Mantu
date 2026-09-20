/**
 * Métis 2.0 Cap 2 — command runtime: wake → pill → mid-sentence execute → thank-you dismiss.
 * Deterministic path works with Jev OFF. Stop/Escape never waits on /v1/decide.
 */

import { desktopActionFingerprint, desktopActionMayReachDecide } from '@shared/desktop-actions'
import {
  idleMetisCommandSession,
  pendingFingerprints,
  reduceMetisCommandSession,
  type MetisCommandSessionState
} from '@shared/metis-command-session'
import { executeDesktopAction, type DesktopAdapterPlatform } from './desktop-adapters'
import { decideActionDisambiguate } from './metis-decide-client'

export const METIS_COMMAND_IDLE_TIMEOUT_MS = 8_000
const METIS_COMMAND_SETTLE_DELAY_MS = 50

export type MetisCommandRuntimeHooks = {
  onState: (state: MetisCommandSessionState) => void
  /** Optional: seat has decisionProviders.jev from heartbeat. */
  jevEnabled?: () => boolean
  operatorDecideAuth?: () => { baseUrl: string; authorizationHeader: string } | null
  platform?: DesktopAdapterPlatform
  fetchImpl?: typeof fetch
  /** Test seam only; production uses the allowlisted desktop adapter. */
  execute?: typeof executeDesktopAction
}

export class MetisCommandRuntime {
  private state: MetisCommandSessionState = idleMetisCommandSession()
  private running = false
  private listenCopyTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimerGeneration = 0
  private generation = 0

  constructor(private readonly hooks: MetisCommandRuntimeHooks) {
    this.emit()
  }

  getState(): MetisCommandSessionState {
    return this.state
  }

  /** Feed trusted local ASR text. Meeting channel is a defense-in-depth no-op. */
  ingestTranscript(text: string, channel: 'meeting' | 'command'): void {
    if (channel !== 'command') return
    const wasActive = this.state.active
    const next = reduceMetisCommandSession(this.state, { type: 'transcript', text, channel })

    if (wasActive && !next.active) {
      const generation = ++this.generation
      this.clearTimers()
      this.apply(next)
      this.settleToIdle(generation)
      return
    }

    if (!wasActive && next.active) this.clearSettleTimer()
    this.apply(next)
    if (!wasActive && next.active) this.armListeningCopy()
    if (next.active) this.armIdleTimeout()
    else this.clearIdleTimer()
    if (next.pending.length) void this.flushPending()
    else if (next.lastParse?.ambiguous && next.active) void this.maybeDisambiguate(next)
  }

  /** Local Stop / Escape — immediate; does not await decide. */
  stopLocal(reason = 'escape'): void {
    const generation = ++this.generation
    this.clearTimers()
    const next = reduceMetisCommandSession(this.state, { type: 'stop' })
    next.reason = reason
    this.apply(next)
    this.settleToIdle(generation)
  }

  /** Revoke command authority when a capture owner is replaced, stopped, or destroyed. */
  reset(reason = 'source_replaced'): void {
    this.generation++
    this.clearTimers()
    this.apply({ ...idleMetisCommandSession(), reason })
  }

  private armListeningCopy(): void {
    this.clearListeningCopy()
    this.listenCopyTimer = setTimeout(() => {
      const next = reduceMetisCommandSession(this.state, { type: 'tick_listening_copy' })
      this.apply(next)
    }, 450)
  }

  private clearListeningCopy(): void {
    if (this.listenCopyTimer) {
      clearTimeout(this.listenCopyTimer)
      this.listenCopyTimer = null
    }
  }

  private armIdleTimeout(): void {
    this.clearIdleTimer()
    const generation = ++this.idleTimerGeneration
    this.idleTimer = setTimeout(() => {
      if (generation !== this.idleTimerGeneration || !this.state.active) return
      this.idleTimer = null
      this.stopLocal('inactivity')
    }, METIS_COMMAND_IDLE_TIMEOUT_MS)
  }

  private clearIdleTimer(): void {
    this.idleTimerGeneration++
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private clearTimers(): void {
    this.clearListeningCopy()
    this.clearIdleTimer()
    this.clearSettleTimer()
  }

  private clearSettleTimer(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }

  private settleToIdle(generation: number): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      if (generation !== this.generation) return
      this.settleTimer = null
      this.apply(idleMetisCommandSession())
    }, METIS_COMMAND_SETTLE_DELAY_MS)
  }

  private apply(next: MetisCommandSessionState): void {
    this.state = next
    this.emit()
  }

  private emit(): void {
    this.hooks.onState(this.state)
  }

  private async flushPending(): Promise<void> {
    if (this.running) return
    this.running = true
    const gen = this.generation
    try {
      while (gen === this.generation) {
        const req = this.state.pending[0]
        if (!req) break
        await (this.hooks.execute ?? executeDesktopAction)(req, this.hooks.platform)
        if (gen !== this.generation) break
        const next = reduceMetisCommandSession(this.state, {
          type: 'mark_committed',
          fingerprints: [desktopActionFingerprint(req)]
        })
        this.apply(next)
      }
    } finally {
      this.running = false
      // A prior action can finish after a replacement session starts. The old generation must not
      // commit into that session, but it must release the runner so its new pending work can drain.
      if (this.state.pending.length) void this.flushPending()
    }
  }

  private async maybeDisambiguate(snapshot: MetisCommandSessionState): Promise<void> {
    if (!this.hooks.jevEnabled?.()) return
    const auth = this.hooks.operatorDecideAuth?.()
    if (!auth) return
    const candidates = (snapshot.lastParse?.provisional || []).filter(desktopActionMayReachDecide)
    if (!candidates.length) return
    const gen = this.generation
    const result = await decideActionDisambiguate({
      operatorBaseUrl: auth.baseUrl,
      authorizationHeader: auth.authorizationHeader,
      transcript: snapshot.liveTranscript,
      candidates,
      deadlineMs: 1200,
      fetchImpl: this.hooks.fetchImpl
    })
    if (gen !== this.generation) return
    if (!result.ok) return // deterministic path already primary; ignore outage
    // Soft hint only: re-ingest does not auto-force; caller may use adapter id later.
    void result
  }
}

export function createMetisCommandRuntime(hooks: MetisCommandRuntimeHooks): MetisCommandRuntime {
  return new MetisCommandRuntime(hooks)
}

export { pendingFingerprints }
