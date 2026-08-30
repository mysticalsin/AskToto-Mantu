/**
 * Act 4 (Vibe) — the onboarding "personalize" scene's mode picker (see OnboardingExperience.tsx),
 * per the Vibe-Island-teardown-referenced brief: "the ONE emotional/personality choice placed
 * deliberately after the heavy config step." Métis's real personality lever is `settings.mode` (see
 * `src/main/personas.ts`'s `buildSystem`, which selects the mode's system prompt from
 * `DEFAULT_MODE_PROMPTS` in `@shared/prompts`) — this module is nothing more than an honest, testable
 * projection of that same reality into three short lines, kept out of the component so the "does this
 * actually describe what the mode does" claim has somewhere to be checked (persona-vibe.test.ts).
 *
 * Deliberately NOT a general mode registry: the onboarding beat only ever offers these three (the full
 * nine-mode roster in `CONVERSATION_MODES`/`MODE_GROUPS`, ipc.ts, stays a Settings-only pick, same as
 * before this scene existed) — a stray 'interview'/'meeting'/etc. id here would be a bug, not a feature,
 * so the id union is deliberately narrow rather than `BuiltinMode`.
 */

export type OnboardingPersonaId = 'general' | 'sales' | 'recruiting'

export interface PersonaVibe {
  id: OnboardingPersonaId
  label: string
  /** Short, Métis-voiced line naming the FEEL of the mode — the "vibe", not a feature list. */
  vibe: string
  /** One truthful line of what the mode actually changes in Métis's behavior. Must stay grounded in the
   *  mode's real system prompt (`DEFAULT_MODE_PROMPTS[id]` in @shared/prompts) — never a capability the
   *  prompt doesn't back. persona-vibe.test.ts's groundedness check is the regression guard against this
   *  drifting into marketing copy over time. */
  changes: string
}

export const ONBOARDING_PERSONAS: readonly PersonaVibe[] = [
  {
    id: 'general',
    label: 'General',
    vibe: 'The sharp generalist',
    changes: 'Every meeting, every topic — answers first, no padding.'
  },
  {
    id: 'sales',
    label: 'Sales',
    vibe: 'Closer instincts',
    changes: 'Names the objection as it lands and pushes every call toward a concrete next step.'
  },
  {
    id: 'recruiting',
    label: 'Recruiting',
    vibe: "The interviewer's edge",
    changes: 'Feeds you one STAR probe at a time and challenges answers that stay vague.'
  }
] as const

/** Resolve an onboarding persona id, falling back to 'general' for anything unrecognized rather than
 *  throwing — the picker always has a selection, so this should never need its fallback in practice. */
export function personaVibe(id: OnboardingPersonaId): PersonaVibe {
  return ONBOARDING_PERSONAS.find((p) => p.id === id) ?? ONBOARDING_PERSONAS[0]
}
