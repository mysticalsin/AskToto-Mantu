import type { AskStart, Settings } from '@shared/ipc'
import { redactSecrets } from '@shared/redact'
import { buildSystem } from '../personas'
import { userText } from './shared'

/**
 * Builds the EXACT token prefix a real live suggest request sends (PLAN.md §4.4's pre-warm contract, F4
 * hardening) — a fake, minimal AskStart-shaped suggest request run through the SAME functions the live
 * suggest path uses (openai.ts's openaiMessages(): [system via buildSystem(), ...history, user via
 * userText()]). Suggest requests never carry chat history (the renderer's instant-suggestions effect never
 * threads one through for the live suggest line), so this always returns exactly [system, user].
 *
 * Exported so BOTH index.ts's local:prewarm handler AND its own unit test call this single implementation
 * — any future drift between the live suggest path and what prewarm warms fails a test instead of silently
 * missing the KV cache hit (which is exactly the bug this fix addresses: the prior prewarm() sent a bare
 * user message with no system prompt at all, so cache_prompt never actually matched a real suggest turn's
 * prefix).
 */
export function buildPrewarmMessages(
  text: string,
  s: Pick<
    Settings,
    | 'mode'
    | 'profile'
    | 'modePrompts'
    | 'contextDocs'
    | 'outputLanguage'
    | 'summaryLanguage'
    | 'systemPrompt'
    | 'redactSensitive'
  >
): Array<{ role: 'system' | 'user'; content: string }> {
  // Mirrors index.ts's askStart handler exactly: redact the transcript BEFORE it ever reaches
  // buildSystem/userText, same as a real request does when settings.redactSensitive is on.
  const transcript = s.redactSensitive && text ? redactSecrets(text) : text
  const req: AskStart = { id: 'prewarm', mode: 'suggest', prompt: '', transcript, history: [] }
  const system = buildSystem(
    req,
    s.mode,
    s.profile,
    s.modePrompts,
    s.contextDocs[s.mode] || [],
    s.outputLanguage,
    s.summaryLanguage,
    s.systemPrompt
  )
  return [
    { role: 'system', content: system },
    { role: 'user', content: userText(req) }
  ]
}
