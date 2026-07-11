/**
 * prewarm.test.ts — proves F4 (prewarm prefix parity) for the HISTORY-FREE suggest contract:
 * buildPrewarmMessages() must build the EXACT same [system, user] prefix a real live suggest request sends
 * when no copilot history exists yet (the instant/proactive suggestion path this pre-warm targets — see
 * prewarm.ts's doc comment, G3). It does NOT cover — and is not a parity guarantee for — a later suggest
 * turn that threads copilotHistoryRef.current in ([system, ...history, user]); that case still reuses the
 * shared system prefix but is out of scope for this suite. Rather than hand-duplicating the expected
 * string, each test builds its expectation from buildSystem()/userText() directly (the same functions the
 * real openai.ts's openaiMessages() calls) — so any future drift between the live history-free suggest path
 * and this helper fails here instead of silently missing the KV cache hit.
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, type AskStart, type Settings } from '@shared/ipc'
import { buildSystem } from '../personas'
import { userText } from './shared'
import { buildPrewarmMessages } from './prewarm'

function expectedMessages(text: string, s: Settings): Array<{ role: 'system' | 'user'; content: string }> {
  const req: AskStart = { id: 'prewarm', mode: 'suggest', prompt: '', transcript: text, history: [] }
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

describe('buildPrewarmMessages — must match the EXACT prefix a real HISTORY-FREE suggest request sends (PLAN.md §4.4, F4; history-free contract only, see G3)', () => {
  it('equals [system, user] built directly from buildSystem()+userText() for DEFAULT_SETTINGS', () => {
    const text = 'THEM: what did the client say about pricing?'
    expect(buildPrewarmMessages(text, DEFAULT_SETTINGS)).toEqual(expectedMessages(text, DEFAULT_SETTINGS))
  })

  it('still matches when mode/language/systemPrompt are customized (drift guard against a future divergent implementation)', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, mode: 'sales', outputLanguage: 'French', systemPrompt: 'CUSTOM PREFIX MARKER' }
    const text = 'THEM: what is your budget for this?'
    expect(buildPrewarmMessages(text, s)).toEqual(expectedMessages(text, s))
  })

  it('sends exactly two messages (system, user) — never a history array, matching a real suggest turn', () => {
    const messages = buildPrewarmMessages('THEM: hello', DEFAULT_SETTINGS)
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
  })

  it('the user message wraps the transcript exactly like a real suggest turn (live-transcript wrapper text)', () => {
    const messages = buildPrewarmMessages('THEM: what next?', DEFAULT_SETTINGS)
    expect(messages[1].content).toContain('Live transcript of the conversation I am in right now')
    expect(messages[1].content).toContain('THEM: what next?')
  })

  it('redacts the transcript before building the prefix when settings.redactSensitive is on — mirrors askStart (index.ts)', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, redactSensitive: true }
    const secretText = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG\n-----END PRIVATE KEY-----'
    const messages = buildPrewarmMessages(secretText, s)
    expect(messages[1].content).not.toContain('MIIBVQIBADANBgkqhkiG')
    expect(messages[1].content).toContain('[redacted private key]')
  })

  it('does NOT redact when settings.redactSensitive is off — mirrors askStart’s own conditional exactly', () => {
    const s: Settings = { ...DEFAULT_SETTINGS, redactSensitive: false }
    const secretText = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG\n-----END PRIVATE KEY-----'
    const messages = buildPrewarmMessages(secretText, s)
    expect(messages[1].content).toContain('MIIBVQIBADANBgkqhkiG')
  })
})
