import type { StreamHandle } from './shared'

/**
 * Hedge delay (ADR-6, F3): how long the primary provider gets before a backup starts racing it. Sits
 * comfortably under every ask tier's idle budget (15s live-suggest, 45s+ everything else — see
 * main/index.ts's baseIdleMs), so hedging can never itself cause a timeout that would not have
 * happened anyway; it only ever shortens the worst case.
 */
export const HEDGE_DELAY_MS = 3000

export type HedgeLeg = 'primary' | 'hedge'

/**
 * Single-writer race gate for one hedged ask (main/index.ts's attempt()/failover()). Exactly two legs
 * ever compete — the primary provider and the one backup started after HEDGE_DELAY_MS — and at most one
 * leg's output ever reaches the renderer: the first to produce a real token wins, and the other's stream
 * is aborted immediately, wherever it currently is.
 *
 * Every provider strategy already suppresses its own onDone/onError once `.abort()` is called (e.g.
 * openai.ts's `if (controller.signal.aborted) return` before calling onError) — the same contract the
 * renderer's own cancel path already relies on (state.ts's cancelledIdsRef doc comment: "a genuinely
 * cancelled stream never emits either"). So declaring a winner and aborting the loser is enough to keep
 * the loser silent for good.
 *
 * The two things that alone can't guarantee:
 *  - A leg that fails for a REAL reason (not an abort) before either leg has a token must still be free
 *    to retry/fail over under its own leg identity — isLoser() reports false while the race is
 *    undecided, so a transient hiccup in the backup doesn't dead-end the ask instead of continuing to race.
 *  - A leg whose OWN retry/failover cascade is fully exhausted must not immediately error out to the
 *    renderer while the other leg might still answer — markDead() only says "surface this" once every
 *    leg (including a backup that hasn't started yet) is confirmed unable to answer.
 */
export class HedgeRace {
  private winner: HedgeLeg | null = null
  private handles: Partial<Record<HedgeLeg, StreamHandle>> = {}
  private deadLegs = new Set<HedgeLeg>()
  // Flips false once the hedge timer fires and finds no eligible backup — from then on 'primary' is
  // effectively racing alone, so ITS exhaustion alone is enough to surface an error.
  private hedgeMayStart = true
  // Non-StreamHandle teardown (a same-provider retry backoff timer) that a cancel must also clear —
  // setHandle/abort alone can't reach a pending setTimeout.
  private cleanups: Array<() => void> = []

  /** Register a leg's live stream handle. If the OTHER leg already won (this leg finished creating its
   *  stream just after losing), abort it right away instead of ever letting it emit. */
  setHandle(leg: HedgeLeg, handle: StreamHandle): void {
    this.handles[leg] = handle
    if (this.winner && this.winner !== leg) handle.abort()
  }

  /** False while undecided (both legs still race normally) and for the winning leg itself — true only
   *  for the leg that lost. The one check every handler (onDelta/onDone/onError) makes before doing
   *  anything renderer-visible or side-effecting. */
  isLoser(leg: HedgeLeg): boolean {
    return this.winner !== null && this.winner !== leg
  }

  /** Call on a leg's first real token. Idempotent — only the first caller across both legs actually wins.
   *  Aborts the other leg's handle immediately (or, via setHandle above, the moment it registers one). */
  declareWinner(leg: HedgeLeg): void {
    if (this.winner) return
    this.winner = leg
    const loser: HedgeLeg = leg === 'primary' ? 'hedge' : 'primary'
    this.handles[loser]?.abort()
  }

  /** True once a winner exists — gates whether the hedge timer should still bother starting the backup. */
  isDecided(): boolean {
    return this.winner !== null
  }

  /** The hedge timer found no eligible backup provider — from here on the primary is racing alone, so
   *  its own exhaustion is a genuine terminal outcome rather than "wait for the other leg". */
  markHedgeUnavailable(): void {
    this.hedgeMayStart = false
  }

  /** A leg's retry/failover cascade is fully exhausted (no more options for THIS leg). Returns 'surface'
   *  only once every leg that could still answer — including a backup not yet started — is confirmed
   *  dead; otherwise 'suppress', so the caller swallows its own error and lets the other leg keep racing. */
  markDead(leg: HedgeLeg): 'surface' | 'suppress' {
    this.deadLegs.add(leg)
    const otherLeg: HedgeLeg = leg === 'primary' ? 'hedge' : 'primary'
    const otherStillViable = otherLeg === 'hedge' ? this.hedgeMayStart && !this.deadLegs.has('hedge') : !this.deadLegs.has('primary')
    return otherStillViable ? 'suppress' : 'surface'
  }

  /** Register an extra teardown a cancel must also run (a pending same-provider retry backoff timer is
   *  not a StreamHandle, so setHandle alone can't cover it). */
  addCleanup(fn: () => void): void {
    this.cleanups.push(fn)
  }

  /** User cancelled the whole ask: abort whichever handle(s) exist and run any pending timer cleanups.
   *  Each provider strategy's own abort-suppression (see the class doc comment) silences both legs from
   *  here — no winner needs declaring, there is no race left to referee. */
  abortAll(): void {
    this.handles.primary?.abort()
    this.handles.hedge?.abort()
    for (const fn of this.cleanups.splice(0)) fn()
  }
}
