/**
 * Which published or running outputs a transcript correction outdates (Métis 2.12 G15, CAP-03).
 *
 * The ledger tells its owner when a final line was corrected or retracted (`onCorrection`); a speaker label that
 * replaces another label is the same kind of event. Each correction advances one counter and remembers which line it
 * touched. A `LineDeps` is what an output read: the counter at that moment and the ids of the lines it contained.
 * It is affected exactly when one of those lines was corrected after the counter it holds, so an output that read the
 * corrected revision, or never contained the line, is untouched. Pure and dependency-free; it never holds line text.
 */

export interface LineDeps {
  /** The tracker's counter when the output read the transcript. */
  readonly epoch: number
  /** The utterance ids the output contained. */
  readonly lines: ReadonlySet<string>
}

/** Corrections remembered per meeting. Past it, an output older than the forgotten ones is treated as affected. */
export const MAX_TRACKED_CORRECTIONS = 4_096

export class CorrectionTracker {
  readonly #limit: number
  #epoch = 0
  /** Corrections at or below this counter were forgotten: an older capture cannot prove it was spared. */
  #floor = 0
  /** Utterance id to the counter of its latest correction, oldest first. */
  readonly #touched = new Map<string, number>()

  constructor(limit: number = MAX_TRACKED_CORRECTIONS) {
    this.#limit = Math.max(1, Math.floor(limit))
  }

  get epoch(): number {
    return this.#epoch
  }

  /** One line was corrected, retracted or relabelled. Returns the new counter. */
  record(utteranceId: string): number {
    this.#epoch += 1
    this.#touched.delete(utteranceId)
    this.#touched.set(utteranceId, this.#epoch)
    while (this.#touched.size > this.#limit) {
      const oldest = this.#touched.entries().next().value
      if (oldest === undefined) break
      this.#touched.delete(oldest[0])
      this.#floor = Math.max(this.#floor, oldest[1])
    }
    return this.#epoch
  }

  /** What an output that reads these lines right now depends on. */
  capture(lines: Iterable<string>): LineDeps {
    return { epoch: this.#epoch, lines: new Set(lines) }
  }

  /** True when a line the output contained was corrected after the output read it. */
  affects(deps: LineDeps): boolean {
    if (deps.epoch === this.#epoch) return false
    if (deps.epoch < this.#floor) return true
    for (const [id, at] of this.#touched) if (at > deps.epoch && deps.lines.has(id)) return true
    return false
  }
}
