import { describe, expect, it } from 'vitest'
import { AskStartSchema } from './ipc'
import {
  AskContextRequestSchema,
  LAST_THEM_SLOT,
  SESSION_CONTEXT_DEFAULT_TAIL,
  SESSION_CONTEXT_MAX_TAIL,
  SessionLedgerLineSchema,
  TRANSCRIPT_SLOT,
  askContext
} from './session-context-request'

describe('AskContextRequestSchema', () => {
  it('defaults the tail to the size suggestions used before', () => {
    expect(AskContextRequestSchema.parse({ kind: 'conversation' })).toEqual({
      kind: 'conversation',
      tailChars: SESSION_CONTEXT_DEFAULT_TAIL
    })
    expect(SESSION_CONTEXT_DEFAULT_TAIL).toBe(6_000)
  })

  it('names exactly the four output kinds and bounds the tail', () => {
    for (const kind of ['conversation', 'screen', 'manual', 'followup'] as const) {
      expect(AskContextRequestSchema.safeParse({ kind }).success).toBe(true)
    }
    expect(AskContextRequestSchema.safeParse({ kind: 'recap' }).success).toBe(false)
    expect(AskContextRequestSchema.safeParse({ kind: 'manual', tailChars: SESSION_CONTEXT_MAX_TAIL + 1 }).success).toBe(
      false
    )
    expect(AskContextRequestSchema.safeParse({ kind: 'manual', tailChars: 1.5 }).success).toBe(false)
  })

  it('is strict: it cannot carry text, only a request for text', () => {
    expect(AskContextRequestSchema.safeParse({ kind: 'manual', transcript: 'text' }).success).toBe(false)
    expect(AskContextRequestSchema.safeParse({ kind: 'manual', text: 'text' }).success).toBe(false)
  })

  it('is optional on an ask and is the only live-conversation field the renderer can add', () => {
    const base = { id: 'r1', mode: 'suggest' }
    expect(AskStartSchema.parse(base).context).toBeUndefined()
    expect(AskStartSchema.parse({ ...base, context: askContext('conversation', { field: true }) }).context).toEqual({
      kind: 'conversation',
      tailChars: SESSION_CONTEXT_DEFAULT_TAIL,
      field: true
    })
  })

  it('uses two distinct slot tokens that no typed question contains by accident', () => {
    expect(TRANSCRIPT_SLOT).not.toBe(LAST_THEM_SLOT)
    expect(TRANSCRIPT_SLOT).toMatch(/^⟦metis:/)
    expect(LAST_THEM_SLOT).toMatch(/^⟦metis:/)
  })
})

describe('SessionLedgerLineSchema', () => {
  const final = { op: 'final', startedAt: 1_700_000_000_000, t: 5, speaker: 'them', text: 'hello' }

  it('accepts a final and a retraction', () => {
    expect(SessionLedgerLineSchema.safeParse(final).success).toBe(true)
    expect(SessionLedgerLineSchema.safeParse({ op: 'retract', startedAt: 1_700_000_000_000, t: 5 }).success).toBe(true)
  })

  it('accepts a speaker name and language on a final and a label by commit time or utterance id', () => {
    expect(SessionLedgerLineSchema.safeParse({ ...final, name: 'Alice', lang: 'English' }).success).toBe(true)
    expect(
      SessionLedgerLineSchema.safeParse({ op: 'label-local', startedAt: 1_700_000_000_000, t: 5, name: 'A' }).success
    ).toBe(true)
    expect(
      SessionLedgerLineSchema.safeParse({
        op: 'label-segment',
        startedAt: 1_700_000_000_000,
        utteranceId: '1:system:1:2'
      }).success
    ).toBe(true)
  })

  it('refuses empty or oversized text, unknown speakers, extra keys and a retraction that carries text', () => {
    expect(SessionLedgerLineSchema.safeParse({ ...final, text: '' }).success).toBe(false)
    expect(SessionLedgerLineSchema.safeParse({ ...final, text: 'x'.repeat(16_385) }).success).toBe(false)
    expect(SessionLedgerLineSchema.safeParse({ ...final, speaker: 'system' }).success).toBe(false)
    expect(SessionLedgerLineSchema.safeParse({ ...final, nickname: 'Alice' }).success).toBe(false)
    expect(
      SessionLedgerLineSchema.safeParse({ op: 'retract', startedAt: 1_700_000_000_000, t: 5, text: 'x' }).success
    ).toBe(false)
  })
})
