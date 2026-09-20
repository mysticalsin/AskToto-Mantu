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

export type MetisCommandRuntimeHooks = {
  onState: (state: MetisCommandSessionState) => void
  /** Optional: seat has decisionProviders.jev from heartbeat. */
  jevEnabled?: () => boolean
  operatorDecideAuth?: () => { baseUrl: string; authorizationHeader: string } | null
  platform?: DesktopAdapterPlatform
  fetchImpl?: typeof fetch
}

export class MetisCommandRuntime {
  private state: MetisCommandSessionState = idleMetisCommandSession()
  private running = false
  private listenCopyTimer: ReturnType<typeof setTimeout> | null = null
  private generation = 0

  constructor(private readonly hooks: MetisCommandRuntimeHooks) {
    this.emit()
  }

  getState(): MetisCommandSessionState {
    return this.state
  }

  /** Feed ASR text. Meeting channel never executes. */
  ingestTranscript(text: string, channel: 'meeting' | 'command' | 'always'): void {
    const next = reduceMetisCommandSession(this.state, { type: 'transcript', text, channel })
    this.apply(next)
    if (next.phase === 'waking') this.armListeningCopy()
    if (next.pending.length) void this.flushPending(next)
    else if (next.lastParse?.ambiguous && next.active) void this.maybeDisambiguate(next)
  }

  /** Local Stop / Escape — immediate; does not await decide. */
  stopLocal(reason = 'escape'): void {
    this.generation++
    this.clearListeningCopy()
    const next = reduceMetisCommandSession(this.state, { type: 'stop' })
    next.reason = reason
    this.apply(next)
    // Settle deactivating → idle on next microtask so UI can play double chime.
    setTimeout(() => {
      this.apply(idleMetisCommandSession())
    }, 50)
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

  private apply(next: MetisCommandSessionState): void {
    this.state = next
    this.emit()
  }

  private emit(): void {
    this.hooks.onState(this.state)
  }

  private async flushPending(snapshot: MetisCommandSessionState): Promise<void> {
    if (this.running) return
    this.running = true
    const gen = this.generation
    try {
      const fps: string[] = []
      for (const req of snapshot.pending) {
        if (gen !== this.generation) break
        await executeDesktopAction(req, this.hooks.platform)
        fps.push(desktopActionFingerprint(req))
      }
      if (gen === this.generation && fps.length) {
        const next = reduceMetisCommandSession(this.state, { type: 'mark_committed', fingerprints: fps })
        this.apply(next)
      }
    } finally {
      this.running = false
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
