import type { StreamHandle } from './shared'

/**
 * Hedge delay (ADR-6, F3): how long the primary provider gets before a backup starts racing it. Sits
 * comfortably under every ask tier's idle budget (15s live-suggest, 45s+ everything else — see
 * main/index.ts's baseIdleMs), so hedging can never itself cause a timeout that would not have
 * happened anyway; it only ever shortens the worst case.
 */
export const HEDGE_DELAY_MS = 3000
/** Live suggest has a tight idle budget — pull the backup earlier than answer/vision so a slow primary
 *  still leaves room for a useful hedge within the turn. Paid double-bill risk is lower than missing
 *  the suggest window entirely. Local backup still uses delay 0 (see askStart). */
export const HEDGE_DELAY_SUGGEST_MS = 1200

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

  /** How the dispatcher starts the backup leg early. Registered once, alongside the HEDGE_DELAY_MS timer
   *  that is the normal trigger. */
  private hedgeStarter: (() => void) | null = null
  private hedgeStarted = false

  /** Wire up the backup leg's launcher so markDead() can pull it forward (see startHedgeEarly below). */
  setHedgeStarter(fn: () => void): void {
    this.hedgeStarter = fn
  }

  /** The backup leg is now running — whether pulled forward or fired by the normal timer. Keeps the two
   *  triggers from ever starting it twice. */
  markHedgeStarted(): void {
    this.hedgeStarted = true
  }

  /**
   * Start the backup NOW instead of waiting out the rest of HEDGE_DELAY_MS. Called when the primary leg
   * is already dead: the delay exists to give a possibly-slow primary a head start, and a dead primary
   * has nothing left to win with, so waiting only adds latency. Found by physically driving the app —
   * a misconfigured primary died at ~0.4s but the answer still took 3.7s, because the backup sat idle
   * until the timer. No-op once the hedge has started, the race is decided, or no backup is available.
   */
  private startHedgeEarly(): void {
    if (this.hedgeStarted || this.winner || !this.hedgeMayStart || !this.hedgeStarter) return
    this.hedgeStarted = true
    this.hedgeStarter()
  }

  /** A leg's retry/failover cascade is fully exhausted (no more options for THIS leg). Returns 'surface'
   *  only once every leg that could still answer — including a backup not yet started — is confirmed
   *  dead; otherwise 'suppress', so the caller swallows its own error and lets the other leg keep racing.
   *  When the primary is the one that died and the backup hasn't started yet, the backup is pulled
   *  forward rather than left waiting on the timer. */
  markDead(leg: HedgeLeg): 'surface' | 'suppress' {
    this.deadLegs.add(leg)
    // Try the backup FIRST, then judge viability — order is load-bearing. startHedgeEarly() calls
    // pickFailover, and when there is no eligible backup it flips hedgeMayStart to false. Judging first
    // would read the stale `true`, return 'suppress' on the strength of a leg that was just proven
    // impossible, and the ask would end with no answer AND no error — a permanent spinner. Deciding
    // after means "suppress" is only ever said when a leg really is running or still startable.
    // Self-guarded: a no-op once the hedge has started, the race is won, or the backup is unavailable.
    if (leg === 'primary') this.startHedgeEarly()
    // MQA-151: once a winner exists, the other leg is aborted and startHedgeLeg refuses to launch a backup,
    // so `hedgeMayStart` below is a stale "might still answer". The WINNER dying after its first token (idle
    // watchdog, a mid-stream socket reset) is therefore the ask's real terminal outcome — suppressing it left
    // no streamDone and no streamError, a spinner that never stops and the combined streams entry unreleased.
    // A LOSER reaching here (its own retry backoff fired after it lost) must still stay silent, or its error
    // would land on top of the winner's live answer.
    if (this.winner !== null) return this.winner === leg ? 'surface' : 'suppress'
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
