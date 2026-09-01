import { describe, expect, it } from 'vitest'
import {
  buildFactCheckClaimPrompt,
  buildSpotlightRefPrompt,
  buildWhatNextPrompt,
  chooseQuickActionRoute,
  dustAgentUnavailableMessage,
  planSpotlightRefAsk,
  quickActionUnavailableMessage,
  spotlightRefUnavailableMessage,
  transcriptHasContent
} from './quick-actions'
import { DUST_SPOTLIGHT_REF_AGENT_ID } from './ipc'

describe('quick action request planning', () => {
  it('routes what-to-say-next to the live suggest path when transcript exists', () => {
    expect(
      chooseQuickActionRoute({ kind: 'whatnext', input: '', transcript: 'THEM: Can you send pricing?', canUseScreen: true })
    ).toEqual({ target: 'copilot', transport: 'suggest' })
  })

  it('uses screen context for idle quick actions that otherwise have no transcript', () => {
    expect(chooseQuickActionRoute({ kind: 'whatnext', input: '', transcript: '', canUseScreen: true })).toEqual({
      target: 'answer',
      transport: 'screen'
    })
    expect(chooseQuickActionRoute({ kind: 'summarize', input: '', transcript: '', canUseScreen: true })).toEqual({
      target: 'answer',
      transport: 'screen'
    })
  })

  it('prioritizes the screen over a merely-present transcript for screen-explicit actions', () => {
    // Tony's bug report: "Summarize screen" / no-input "Explain" must actually look at the screen during
    // a meeting, not silently fall back to summarizing the transcript just because one exists.
    expect(
      chooseQuickActionRoute({ kind: 'summarize', input: '', transcript: 'THEM: ship by Friday', canUseScreen: true })
    ).toEqual({ target: 'answer', transport: 'screen' })
    expect(
      chooseQuickActionRoute({ kind: 'explain', input: '', transcript: 'THEM: ship by Friday', canUseScreen: true })
    ).toEqual({ target: 'answer', transport: 'screen' })
  })

  it('still prefers transcript-text for these actions when the screen is unavailable', () => {
    expect(
      chooseQuickActionRoute({ kind: 'summarize', input: '', transcript: 'THEM: ship by Friday', canUseScreen: false })
    ).toEqual({ target: 'answer', transport: 'text' })
    expect(
      chooseQuickActionRoute({ kind: 'explain', input: '', transcript: 'THEM: ship by Friday', canUseScreen: false })
    ).toEqual({ target: 'copilot', transport: 'text' })
  })

  it('explain keeps typed input as text even when the screen is available — explicit input wins', () => {
    expect(
      chooseQuickActionRoute({ kind: 'explain', input: 'quantum computing', transcript: '', canUseScreen: true })
    ).toEqual({ target: 'answer', transport: 'text' })
  })

  it('returns a visible local error when a context-only action has no transcript or screen', () => {
    expect(chooseQuickActionRoute({ kind: 'summarize', input: '', transcript: '', canUseScreen: false })).toEqual({
      target: 'answer',
      transport: 'local-error'
    })
    expect(quickActionUnavailableMessage('summarize')).toContain('screen-capable provider')
  })

  it('keeps typed fact-checks text-only and displays the clean claim', () => {
    const prompt = buildFactCheckClaimPrompt('Revenue grew 30%')
    expect(prompt).toContain('VERDICT: <TRUE|FALSE|MISLEADING|UNVERIFIABLE>')
    expect(prompt).toContain('Claim: "Revenue grew 30%"')
    expect(prompt).not.toContain('undefined')
  })

  it('does not pretend whitespace transcript is usable context', () => {
    expect(transcriptHasContent('  \n  ')).toBe(false)
    expect(transcriptHasContent('THEM: Need an answer?')).toBe(true)
  })

  it('screen what-next asks for a useful answer even without transcript', () => {
    expect(buildWhatNextPrompt('', 'screen')).toContain('visible on my screen')
    expect(buildWhatNextPrompt('', 'screen')).not.toContain('"""\n\n"""')
  })

  it('click with hasKeys.dust false still runs with GOr913Zr5V', () => {
    const planned = planSpotlightRefAsk({
      typed: 'Fintech onboarding',
      transcript: '',
      hasKeys: { dust: false }
    })
    expect(planned.providerOverride).toBe('dust')
    expect(planned.agentOverride).toBe(DUST_SPOTLIGHT_REF_AGENT_ID)
    expect(planned.agentOverride).toBe('GOr913Zr5V')
    expect(planned.mode).toBe('answer')
    expect(planned.prompt).toContain('Fintech onboarding')
  })

  it('spotlight ref prefers typed input over transcript, and asks for references either way', () => {
    const typed = buildSpotlightRefPrompt('THEM: we need SOC2', 'Fintech onboarding use case')
    expect(typed).toContain('Fintech onboarding use case')
    expect(typed).not.toContain('THEM: we need SOC2')
    expect(typed).toContain('sales references or case studies')

    const fromTranscript = buildSpotlightRefPrompt('THEM: we need SOC2', '')
    expect(fromTranscript).toContain('THEM: we need SOC2')
  })

  it('spotlight ref unavailable message asks to Set up Dust / install the CLI, not reconnect', () => {
    const msg = spotlightRefUnavailableMessage()
    expect(msg).toContain('Set up Dust')
    expect(msg).toContain('Settings')
    expect(msg.toLowerCase()).toContain('cli')
    expect(msg.toLowerCase()).not.toContain('reconnect')
    expect(msg.toLowerCase()).not.toContain('pick')
  })

  it('dust agent unavailable message names the agent and points at Settings → AI', () => {
    const msg = dustAgentUnavailableMessage()
    expect(msg.toLowerCase()).toContain('agent')
    expect(msg).toContain('Settings')
    expect(msg.toLowerCase()).toContain('pick one') // base agent IS user-pickable
  })

  it('spotlight variant names Spotlight Ref and gives a reachable remedy, not the dead-end "pick one"', () => {
    // Spotlight Ref's agent is hard-locked (DUST_SPOTLIGHT_REF_AGENT_ID) — the user cannot repick it in
    // the UI, so "pick one in Settings" is dead-end advice. The real remedy is to reconnect Dust to the
    // workspace that actually has the Spotlight Ref agent.
    const msg = dustAgentUnavailableMessage(true)
    expect(msg).toContain('Spotlight Ref')
    expect(msg.toLowerCase()).toContain('not in this workspace')
    expect(msg.toLowerCase()).not.toContain('reconnect')
    expect(msg.toLowerCase()).not.toContain('pick one')
  })
})
