import { describe, expect, it } from 'vitest'
import type { Settings } from '@shared/ipc'
import { canRetainImportedTranscript, SUMMARY_ONLY_IMPORT_REFUSAL } from './import-retention-policy'

const policy = (enterpriseLive: unknown): Settings => ({ enterpriseLive }) as Settings

describe('trusted import transcript-retention policy', () => {
  it('blocks only a valid managed summary-only profile', () => {
    expect(canRetainImportedTranscript(policy({ managed: true, summaryOnly: true }))).toBe(false)
    expect(canRetainImportedTranscript(policy({ managed: true, summaryOnly: false }))).toBe(true)
    expect(canRetainImportedTranscript(policy({ managed: false, summaryOnly: true }))).toBe(true)
    expect(canRetainImportedTranscript(policy({ managed: true, summaryOnly: 'yes' }))).toBe(true)
  })

  it('uses one fixed refusal with no recording or transcript detail', () => {
    expect(SUMMARY_ONLY_IMPORT_REFUSAL).toBe(
      'Recording import currently requires retaining a full transcript. Your organization’s summary-only policy prevents import. Your original recording is unchanged.'
    )
    expect(SUMMARY_ONLY_IMPORT_REFUSAL).not.toMatch(/path|transcript sentinel|\.wav/i)
  })
})
