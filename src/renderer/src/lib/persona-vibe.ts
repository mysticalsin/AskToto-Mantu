/**
 * Act 4 (Vibe) — onboarding mode picker. One entry per built-in mode
 * (`BUILTIN_MODE_LABELS` / `CONVERSATION_MODES`). Each "changes" line is grounded
 * in `DEFAULT_MODE_PROMPTS` (persona-vibe.test.ts).
 */
import type { BuiltinMode } from '@shared/ipc'

export type OnboardingPersonaId = BuiltinMode

export interface PersonaVibe {
  id: OnboardingPersonaId
  label: string
  vibe: string
  changes: string
}

export const ONBOARDING_PERSONAS: readonly PersonaVibe[] = [
  {
    id: 'general',
    label: 'General',
    vibe: 'The sharp generalist',
    changes: 'Every meeting, every topic: answers first, no padding.'
  },
  {
    id: 'meeting',
    label: 'Meeting',
    vibe: 'Keep the room honest',
    changes: 'Tracks decisions, owners, and the number that forces a call.'
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
  },
  {
    id: 'interview',
    label: 'Interview',
    vibe: 'Your side of the table',
    changes: 'Writes the spoken answer in the first sentence, first person.'
  },
  {
    id: 'negotiation',
    label: 'Negotiation',
    vibe: 'Calm and firm',
    changes: 'One move: anchor, counter, trade, hold, or close. Never concede for free.'
  },
  {
    id: 'presentation',
    label: 'Presentation',
    vibe: 'Own the room',
    changes: 'Answer the floor, headline first, then one proof point.'
  },
  {
    id: 'support',
    label: 'Support',
    vibe: 'Fix it, then follow up',
    changes: 'Resolve the issue: empathy first, then what you will do and by when.'
  },
  {
    id: 'cold-call',
    label: 'Cold Calling',
    vibe: 'Open, then earn the next',
    changes: 'Earn the next 10 seconds, handle the objection, ask for a booked meeting.'
  }
] as const

export function personaVibe(id: OnboardingPersonaId): PersonaVibe {
  return ONBOARDING_PERSONAS.find((p) => p.id === id) ?? ONBOARDING_PERSONAS[0]
}
