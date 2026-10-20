/**
 * recovered-draft-count.ts — the main-process owner of "how many crash-recovery drafts were promoted this
 * launch" and the revision that versions every snapshot of it.
 *
 * The count belongs to the active profile. A confirmed profile recovery archives the encrypted profile, so
 * the drafts counted before it are no longer this owner's: the count drops to zero under a NEW revision,
 * and orphan-recovery work that began under the previous revision must not publish its result afterward.
 * The renderer accepts only snapshots whose revision is at least the last one it applied.
 */

export interface RecoveredDraftCountSnapshot {
  count: number
  revision: number
}

export class RecoveredDraftCount {
  #count = 0
  #revision = 0

  /** The current owner's snapshot. An unauthenticated caller sees zero drafts but the live revision. */
  snapshot(authorized = true): RecoveredDraftCountSnapshot {
    return { count: authorized ? this.#count : 0, revision: this.#revision }
  }

  /** A confirmed profile recovery: forget the previous profile's drafts under a new revision. */
  resetForProfileRecovery(): void {
    this.#count = 0
    this.#revision += 1
  }

  /** Captured before orphan recovery starts; compare with {@link isCurrent} when it settles. */
  revisionToken(): number {
    return this.#revision
  }

  isCurrent(token: number): boolean {
    return token === this.#revision
  }

  /**
   * Records drafts recovered by work that began under `token`. Returns false (and changes nothing) when the
   * work is stale or recovered nothing, so the caller publishes only an accepted change.
   */
  recordRecovered(token: number, recovered: number): boolean {
    if (!this.isCurrent(token) || !(recovered > 0)) return false
    this.#count = recovered
    this.#revision += 1
    return true
  }
}
