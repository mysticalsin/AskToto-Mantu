import type { ChatTurn } from '@shared/ipc'

/**
 * Renderer-side half of correction invalidation (Métis 2.12 G15). Main reports, by run id and without any text, which
 * delivered answers or suggestions read a transcript line its ledger has since corrected. Follow-up memory keeps the
 * question and answer of such a run only as long as the run is current, so a recorded question carries its run id.
 *
 * The id lives in a WeakMap keyed by the question's turn object, not on the turn: a turn is sent to providers as
 * `{ role, content }` and must stay exactly that, and the memory arrays are copied, sliced and reset by other code.
 */
const owners = new WeakMap<ChatTurn, string>()

/** Marks a recorded question as belonging to run `id`. */
export function rememberTurn(question: ChatTurn, id: string): void {
  owners.set(question, id)
}

/**
 * The memory without the question and the answer of every stale run. Returns the same array when nothing is dropped.
 * A turn that was never recorded here (seeded history) is never dropped.
 */
export function forgetStaleTurns(turns: ChatTurn[], stale: ReadonlySet<string>): ChatTurn[] {
  if (stale.size === 0) return turns
  const kept: ChatTurn[] = []
  let dropped = false
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    const id = turn && owners.get(turn)
    if (turn && id !== undefined && stale.has(id)) {
      dropped = true
      // The answer recorded with this question follows it.
      if (turns[index + 1]?.role === 'assistant') index += 1
      continue
    }
    if (turn) kept.push(turn)
  }
  return dropped ? kept : turns
}
