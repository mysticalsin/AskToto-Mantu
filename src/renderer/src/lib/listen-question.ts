import { classifyTurn } from '@shared/turn-triggers'

export { classifyTurn }
export type { TurnTrigger } from '@shared/turn-triggers'

/** A complete question in EN, FR, PT-BR or ES. Objections are a separate trigger kind (see classifyTurn). */
export function isQuestion(t: string): boolean {
  return classifyTurn(t)?.kind === 'question'
}
