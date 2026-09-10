import { describe, expect, it } from 'vitest'
import { onboardingReadinessCopy } from './onboarding-readiness-copy'

describe('setup describes transcription and AI readiness separately', () => {
  it('does not claim setup is complete before transcription assets are ready', () => {
    expect(onboardingReadinessCopy(false, true).title).toBe('Finishing your setup…')
  })

  it('allows transcription-only use but explains what summaries and answers need', () => {
    const copy = onboardingReadinessCopy(true, false)
    expect(copy.title).toBe('Transcription is ready.')
    expect(copy.aiHint).toMatch(/summaries and answers.*connect AI in Settings/i)
    expect(copy.aiHint).toMatch(/transcription only/i)
    expect(copy.aiAction).toBe('Set up AI for summaries and answers')
    expect(Object.values(copy).join(' ')).not.toMatch(/never required|next step|provider key/i)
  })

  it('describes fully configured setup without requiring a personal API key', () => {
    const copy = onboardingReadinessCopy(true, true)
    expect(copy.title).toBe('You’re all set.')
    expect(copy.aiHint).toMatch(/AI connection is configured/i)
    expect(copy.aiAction).toBe('Manage AI connection (optional)')
  })
})
