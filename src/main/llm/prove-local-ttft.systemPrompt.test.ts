/**
 * prove-local-ttft.systemPrompt.test.ts — cross-checks scripts/prove-local-ttft.mjs's hand-synced
 * buildSuggestSystemPrompt()/suggestUserText() against the REAL production helper (llm/prewarm.ts's
 * buildPrewarmMessages(), F4) for the same DEFAULT_SETTINGS suggest request. The proof script can't import
 * personas.ts's dependency chain directly (a plain .mjs can't run TypeScript without a loader this repo
 * doesn't use for scripts/), so its warmed prefix is a hand-synced copy — this test is what keeps that copy
 * honest: any future drift between personas.ts's buildSystem() and the script's hand-synced constants fails
 * here instead of silently making the TTFT proof warm the wrong prefix.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { buildPrewarmMessages } from './prewarm'
// @ts-expect-error — plain .mjs script, no type declarations; import is fine at runtime under Vite/Vitest.
import { buildSuggestSystemPrompt, suggestUserText } from '../../../scripts/prove-local-ttft.mjs'

describe('prove-local-ttft.mjs system-prompt parity with buildPrewarmMessages (F4)', () => {
  it('buildSuggestSystemPrompt() is byte-identical to the real system message for a DEFAULT-settings suggest request', () => {
    const [systemMessage] = buildPrewarmMessages('THEM: any transcript tail', DEFAULT_SETTINGS)
    expect((buildSuggestSystemPrompt as () => string)()).toBe(systemMessage.content)
  })

  it('suggestUserText() matches the real user message for the same transcript tail', () => {
    const tail = 'THEM: what did the client say about pricing?'
    const [, userMessage] = buildPrewarmMessages(tail, DEFAULT_SETTINGS)
    expect((suggestUserText as (t: string) => string)(tail)).toBe(userMessage.content)
  })
})
