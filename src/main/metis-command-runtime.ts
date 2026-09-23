/**
 * Métis command runtime: trusted command text becomes one proposal only.
 * Execution is deliberately deferred to Task 5's main-owned confirmation boundary.
 */
import { desktopActionMayReachDecide } from '@shared/desktop-actions'
import { commandContextHash } from '@shared/metis-command-proposal'
import {
  idleMetisCommandSession,
  reduceMetisCommandSession,
  type MetisCommandSessionState
} from '@shared/metis-command-session'
import { decideActionDisambiguate } from './metis-decide-client'

export const METIS_COMMAND_IDLE_TIMEOUT_MS = 8_000
const METIS_COMMAND_SETTLE_DELAY_MS = 50

export type MetisCommandRuntimeHooks = {
  onState: (state: MetisCommandSessionState) => void
  /** Optional: seat has decisionProviders.jev from heartbeat. */
  jevEnabled?: () => boolean
  operatorDecideAuth?: () => { baseUrl: string; authorizationHeader: string } | null
  fetchImpl?: typeof fetch
  /** Reserved for Task 5 confirmation; this runtime never calls it. */
  execute?: typeof import('./desktop-adapters').executeDesktopAction
}

export class MetisCommandRuntime {
  private state: MetisCommandSessionState = idleMetisCommandSession()
  private listenCopyTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private proposalTimer: ReturnType<typeof setTimeout> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimerGeneration = 0
  private generation = 0
  private sessionSequence = 0
  private sessionId = ''
  private utteranceRevision = 0
  private decisionController: AbortController | null = null
  private decisionContextHash: string | null = null

  constructor(private readonly hooks: MetisCommandRuntimeHooks) {
    this.emit()
  }

  getState(): MetisCommandSessionState {
    return this.state
  }

  /** Feed only text from a main-owned command capture. Meeting input is always ignored. */
  ingestTranscript(text: string, channel: 'meeting' | 'command'): void {
    if (channel !== 'command') return
    this.abortDecision()
    const wasActive = this.state.active
    const sessionId = wasActive ? this.sessionId : `command-${++this.sessionSequence}`
    const utteranceRevision = ++this.utteranceRevision
    const contextHash = commandContextHash(text)
    const next = reduceMetisCommandSession(this.state, {
      type: 'transcript',
      text,
      channel,
      sessionId,
      utteranceRevision,
      contextHash
    })

    if (!wasActive && next.active) this.sessionId = sessionId
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
    this.armProposalExpiry()
    if (!next.proposal && next.lastParse?.provisional.length && next.active) {
      void this.maybeDisambiguate(next, sessionId, utteranceRevision, contextHash)
    }
  }

  /** Local Stop / Escape — immediate; does not await optional decision work. */
  stopLocal(reason = 'escape'): void {
    const generation = ++this.generation
    this.abortDecision()
    this.clearTimers()
    const next = reduceMetisCommandSession(this.state, { type: 'stop' })
    next.reason = reason
    this.apply(next)
    this.settleToIdle(generation)
  }

  /** Revoke command authority when a capture owner is replaced, stopped, or destroyed. */
  reset(reason = 'source_replaced'): void {
    this.generation++
    this.abortDecision()
    this.clearTimers()
    this.sessionId = ''
    this.utteranceRevision++
    this.apply({ ...idleMetisCommandSession(), reason })
  }

  destroy(): void {
    this.reset('destroyed')
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

  private armProposalExpiry(): void {
    this.clearProposalTimer()
    const proposal = this.state.proposal
    if (!proposal) return
    const proposalId = proposal.id
    const delay = Math.max(0, proposal.expiresAt - Date.now())
    this.proposalTimer = setTimeout(() => {
      this.proposalTimer = null
      const next = reduceMetisCommandSession(this.state, { type: 'proposal_expired', proposalId })
      if (next !== this.state) this.apply(next)
    }, delay)
  }

  private clearProposalTimer(): void {
    if (this.proposalTimer) {
      clearTimeout(this.proposalTimer)
      this.proposalTimer = null
    }
  }

  private clearTimers(): void {
    this.clearListeningCopy()
    this.clearIdleTimer()
    this.clearProposalTimer()
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

  private abortDecision(): void {
    this.decisionController?.abort()
    this.decisionController = null
    this.decisionContextHash = null
  }

  private apply(next: MetisCommandSessionState): void {
    this.state = next
    this.emit()
  }

  private emit(): void {
    this.hooks.onState(this.state)
  }

  private async maybeDisambiguate(
    snapshot: MetisCommandSessionState,
    sessionId: string,
    utteranceRevision: number,
    contextHash: string
  ): Promise<void> {
    if (!this.hooks.jevEnabled?.()) return
    const auth = this.hooks.operatorDecideAuth?.()
    if (!auth) return
    const candidates = (snapshot.lastParse?.provisional || []).filter(desktopActionMayReachDecide)
    if (!candidates.length) return
    const controller = new AbortController()
    this.decisionController = controller
    this.decisionContextHash = contextHash
    const result = await decideActionDisambiguate({
      operatorBaseUrl: auth.baseUrl,
      authorizationHeader: auth.authorizationHeader,
      transcript: snapshot.liveTranscript.slice(0, 512),
      candidates,
      deadlineMs: 1200,
      fetchImpl: this.hooks.fetchImpl,
      signal: controller.signal
    })
    if (
      controller.signal.aborted ||
      this.sessionId !== sessionId ||
      this.utteranceRevision !== utteranceRevision ||
      this.decisionContextHash !== contextHash
    ) {
      return
    }
    if (this.decisionController === controller) this.abortDecision()
    // Advisory only. A remote response cannot create, alter, or execute a proposal.
    void result
  }
}

export function createMetisCommandRuntime(hooks: MetisCommandRuntimeHooks): MetisCommandRuntime {
  return new MetisCommandRuntime(hooks)
}
