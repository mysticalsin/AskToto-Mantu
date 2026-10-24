import { canonicalJson } from '@shared/intervention-contract'
import type { InterruptionMode } from '@shared/proactive-settings'
import type { InterventionGate } from './intervention-gate'

/**
 * Proactive controls (G77): the per-mode profile, the rolling trigger budget and the evidence-novelty ring for
 * unsolicited cards. Pure and timer-free (the clock is injected); state is renderer-session memory only and
 * never holds anything but token sets of the triggers it admitted. Direct asks never import this module.
 */

export interface InterruptionProfile {
  /** Automatic trigger kinds the mode allows. Empty means no unsolicited card. */
  readonly autoTriggers: readonly 'question'[]
  readonly budgetMax: number
  readonly budgetWindowMs: number
  /** The cooldown is the existing `suggestEverySec` rule; G77 adds no second one. */
  readonly cooldown: 'suggestEverySec'
  /** A trigger whose novelty (1 - best Jaccard against the recent ring) is below this is held. */
  readonly minNovelty: number
  /** null = the card stays until dismissed or replaced (G71); no auto-hide timer. */
  readonly visibleMs: null
  /** false = an automatic card never cancels a streaming or user-requested answer. */
  readonly interruptible: false
}

const profile = (p: InterruptionProfile): InterruptionProfile =>
  Object.freeze({ ...p, autoTriggers: Object.freeze([...p.autoTriggers]) as readonly 'question'[] })

const WINDOW_MS = 10 * 60_000
const RING_CAP = 8

export const INTERRUPTION_PROFILES: Readonly<Record<InterruptionMode, InterruptionProfile>> = Object.freeze({
  manual: profile({
    autoTriggers: [],
    budgetMax: 0,
    budgetWindowMs: WINDOW_MS,
    cooldown: 'suggestEverySec',
    minNovelty: 1,
    visibleMs: null,
    interruptible: false
  }),
  questions: profile({
    autoTriggers: ['question'],
    budgetMax: 6,
    budgetWindowMs: WINDOW_MS,
    cooldown: 'suggestEverySec',
    minNovelty: 0.35,
    visibleMs: null,
    interruptible: false
  })
})

export function noveltyTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  )
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

/** 1 for an empty ring or empty text; otherwise 1 minus the highest Jaccard similarity to a ring entry. */
export function novelty(text: string, ring: readonly ReadonlySet<string>[]): number {
  const tokens = noveltyTokens(text)
  if (tokens.size === 0 || ring.length === 0) return 1
  let best = 0
  for (const entry of ring) best = Math.max(best, jaccard(tokens, entry))
  return 1 - best
}

export interface Reservation {
  readonly sessionId: string
  readonly mode: InterruptionMode
  settled: boolean
}

interface SessionState {
  sessionId: string
  admitted: number[]
  pending: Set<Reservation>
  ring: Set<string>[]
}

export class ProactiveControls {
  private state: SessionState = { sessionId: '', admitted: [], pending: new Set(), ring: [] }

  constructor(private readonly now: () => number) {}

  profile(mode: InterruptionMode): InterruptionProfile {
    return INTERRUPTION_PROFILES[mode]
  }

  /** A new sessionId resets the budget and the ring: nothing crosses meetings. */
  private session(sessionId: string): SessionState {
    if (this.state.sessionId !== sessionId) this.state = { sessionId, admitted: [], pending: new Set(), ring: [] }
    return this.state
  }

  /** Takes one budget slot (pending counts), or null when the mode allows none or the window is full. */
  reserve(sessionId: string, mode: InterruptionMode): Reservation | null {
    const p = INTERRUPTION_PROFILES[mode]
    const s = this.session(sessionId)
    const cutoff = this.now() - p.budgetWindowMs
    s.admitted = s.admitted.filter((at) => at > cutoff)
    if (s.admitted.length + s.pending.size >= p.budgetMax) return null
    const reservation: Reservation = { sessionId, mode, settled: false }
    s.pending.add(reservation)
    return reservation
  }

  /** The trigger was admitted: the slot is spent and its evidence joins the novelty ring. */
  commit(reservation: Reservation, triggerText: string): void {
    if (reservation.settled) return
    reservation.settled = true
    const s = this.state
    if (s.sessionId !== reservation.sessionId || !s.pending.delete(reservation)) return
    s.admitted.push(this.now())
    s.ring.push(noveltyTokens(triggerText))
    if (s.ring.length > RING_CAP) s.ring.shift()
  }

  /** The trigger produced no visible card: the slot is refunded and nothing enters the ring. */
  release(reservation: Reservation): void {
    if (reservation.settled) return
    reservation.settled = true
    if (this.state.sessionId === reservation.sessionId) this.state.pending.delete(reservation)
  }

  noveltyOf(sessionId: string, text: string): number {
    return novelty(text, this.session(sessionId).ring)
  }

  /** A playbook change clears the evidence ring only: the budget protects attention, not analysis. */
  invalidatePlaybook(): void {
    this.state.ring = []
  }
}

export interface PlaybookSettings {
  mode?: string
  modePrompts?: Record<string, string>
  customModes?: readonly { id: string; label: string }[]
}

/** In-memory identity of the active playbook (mode, its prompt and its custom-mode entry). Never logged. */
export function playbookFingerprint(settings: PlaybookSettings): string {
  const mode = settings.mode ?? 'general'
  return canonicalJson({
    mode,
    prompt: settings.modePrompts?.[mode] ?? '',
    custom: settings.customModes?.find((m) => m.id === mode) ?? null
  })
}

/**
 * The first fingerprint is the baseline (settings loading is not a change). A later change bumps the gate
 * scope so in-flight cards and shadow results built on the old playbook are stale-dropped, and clears the ring.
 */
export function syncPlaybook(args: {
  baseline: { current: string | null }
  fingerprint: string
  gate: InterventionGate
  controls: ProactiveControls
}): boolean {
  const { baseline, fingerprint, gate, controls } = args
  const previous = baseline.current
  baseline.current = fingerprint
  if (previous === null || previous === fingerprint) return false
  gate.observe({ kind: 'scope', change: 'playbook-change' })
  controls.invalidatePlaybook()
  return true
}
