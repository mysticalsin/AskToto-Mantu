/**
 * Walkthrough voice intents (G44). Pure and deterministic, like the voice grammar: it names an intent, it never
 * decides policy. The caller has already established that the text is the owner's own command (G36); the control
 * words (done, next, pause, resume, stop) are only recognised while a walkthrough is live, so an ordinary "done"
 * or "next" is never swallowed.
 */
export type WalkthroughIntent =
  | { kind: 'start'; goal: string }
  | { kind: 'check' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }

export const WALKTHROUGH_GOAL_MAX_CHARS = 300

const END = '(?![\\p{L}\\p{N}])'
const rx = (source: string): RegExp => new RegExp(source, 'iu')

const WAKE_LEAD = rx(`^(?:(?:hey|hi|ok|okay|ola|olá|oi|salut|hola)[\\s,]+)?m[eé]tis${END}[\\s,:;.!?\\-]*`)
const POLITE_LEAD = rx(
  `^(?:(?:please|por favor|s['’]il (?:te|vous) pla[iî]t)[\\s,]+|(?:can|could|would) you (?:please )?)+`
)
const TRAILING = /[\s.!?¿¡,;:]+$/u

const START_RULES: readonly RegExp[] = [
  rx(`^(?:walk|guide|talk|take)\\s+me\\s+through\\s+(.+)$`),
  rx(`^show\\s+me\\s+how\\s+to\\s+(.+)$`),
  rx(`^help\\s+me\\s+(.+?)\\s+step\\s+by\\s+step$`),
  rx(`^(?:guide-moi|guidez-moi)\\s+(?:pour\\s+|dans\\s+|à travers\\s+|à\\s+)?(.+)$`),
  rx(`^(?:montre-moi|montrez-moi)\\s+comment\\s+(.+)$`),
  rx(`^(?:me guie|guie-me)\\s+(?:para\\s+|em\\s+|por\\s+)?(.+)$`),
  rx(`^(?:me mostre|mostre-me)\\s+como\\s+(.+)$`),
  rx(`^(?:gu[ií]ame)\\s+(?:para\\s+|en\\s+|por\\s+)?(.+)$`),
  rx(`^(?:mu[eé]strame)\\s+c[oó]mo\\s+(.+)$`)
]

const CHECK_RULE = rx(
  `^(?:i['’]?m done|i am done|done|next(?: step)?|check(?: it| that| now)?|j['’]ai fini|termin[eé]|suivant|pr[oó]ximo|feito|pronto|listo|siguiente)${END}$`
)
const PAUSE_RULE = rx(`^(?:pause|hold on|wait)(?: the walkthrough| here)?${END}$`)
const RESUME_RULE = rx(`^(?:resume|continue|carry on)(?: the walkthrough)?${END}$`)
const STOP_RULE = rx(
  `^(?:(?:stop|end|cancel) (?:the )?(?:walkthrough|guide|guiding)|stop guiding(?: me)?|that['’]s enough)${END}$`
)

export function parseWalkthroughIntent(input: string, state: { active: boolean }): WalkthroughIntent | null {
  const text = input.trim().replace(WAKE_LEAD, '').replace(POLITE_LEAD, '').replace(TRAILING, '').trim()
  if (text.length === 0 || text.length > 1_000) return null
  if (state.active) {
    if (STOP_RULE.test(text)) return { kind: 'stop' }
    if (PAUSE_RULE.test(text)) return { kind: 'pause' }
    if (RESUME_RULE.test(text)) return { kind: 'resume' }
    if (CHECK_RULE.test(text)) return { kind: 'check' }
  }
  for (const rule of START_RULES) {
    const match = rule.exec(text)
    const goal = match?.[1]?.trim().replace(TRAILING, '')
    if (goal && goal.length > 0) return { kind: 'start', goal: goal.slice(0, WALKTHROUGH_GOAL_MAX_CHARS) }
  }
  return null
}
