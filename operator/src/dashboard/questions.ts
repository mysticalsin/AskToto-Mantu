import { aggregateQuestionTypes } from '../../../src/shared/question-type'
import type { AskRow } from '../store'
import type { QuestionsPayload } from '../dashboard'

export function buildQuestionsPayload(asks: AskRow[]): QuestionsPayload {
  const mix = aggregateQuestionTypes(asks.map((a) => a.question_type))
  const byModeInput = new Map<string, (string | null)[]>()
  for (const a of asks) {
    const mode = a.mode || 'unknown'
    const arr = byModeInput.get(mode) ?? []
    arr.push(a.question_type)
    byModeInput.set(mode, arr)
  }
  const byMode = [...byModeInput.entries()]
    .map(([mode, types]) => ({ mode, mix: aggregateQuestionTypes(types) }))
    .sort((a, b) => b.mix.total - a.mix.total || a.mode.localeCompare(b.mode))
  return { mix, byMode, coverage: mix.coverage }
}
