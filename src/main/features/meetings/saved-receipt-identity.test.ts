import { describe, expect, it } from 'vitest'
import { matchesSavedReceiptIdentity } from './saved-receipt-identity'

const STARTED_AT = 1_700_000_000_000
const DATE = new Date(STARTED_AT).toISOString()

function document(
  options: {
    type?: string
    date?: string
    revision?: string
    schema?: string
    extra?: string[]
    eol?: '\n' | '\r\n'
  } = {}
): string {
  const eol = options.eol ?? '\n'
  const lines = [
    '---',
    `type: ${options.type ?? 'meeting-transcript'}`,
    `date: ${options.date ?? DATE}`,
    ...(options.revision === undefined ? [] : [`transcriptRevision: ${options.revision}`]),
    ...(options.schema === undefined ? [] : [`revisionSchema: ${options.schema}`]),
    ...(options.extra ?? []),
    '---',
    '# Saved meeting'
  ]
  return lines.join(eol)
}

describe('matchesSavedReceiptIdentity', () => {
  it('accepts a legacy revision-zero transcript and an explicit supported checkpoint', () => {
    expect(matchesSavedReceiptIdentity(document(), STARTED_AT, 0)).toBe(true)
    expect(matchesSavedReceiptIdentity(document({ revision: '2', schema: '1' }), STARTED_AT, 2)).toBe(true)
  })

  it('accepts summary-only and CRLF documents without requiring segment languages', () => {
    expect(matchesSavedReceiptIdentity(document({ type: 'meeting-summary', eol: '\r\n' }), STARTED_AT, 0)).toBe(true)
  })

  it('rejects another meeting date, type, or transcript revision', () => {
    expect(matchesSavedReceiptIdentity(document({ date: new Date(STARTED_AT + 1).toISOString() }), STARTED_AT, 0)).toBe(
      false
    )
    expect(matchesSavedReceiptIdentity(document({ type: 'note' }), STARTED_AT, 0)).toBe(false)
    expect(matchesSavedReceiptIdentity(document({ revision: '1', schema: '1' }), STARTED_AT, 2)).toBe(false)
  })

  it('rejects incomplete, partial, malformed, and future checkpoint metadata', () => {
    expect(matchesSavedReceiptIdentity('---\ntype: meeting-transcript\n', STARTED_AT, 0)).toBe(false)
    expect(matchesSavedReceiptIdentity(document({ revision: '1' }), STARTED_AT, 0)).toBe(false)
    expect(matchesSavedReceiptIdentity(document({ schema: '1' }), STARTED_AT, 0)).toBe(false)
    expect(matchesSavedReceiptIdentity(document({ revision: 'not-a-number', schema: '1' }), STARTED_AT, 0)).toBe(false)
    expect(matchesSavedReceiptIdentity(document({ revision: '-1', schema: '1' }), STARTED_AT, 0)).toBe(false)
    expect(matchesSavedReceiptIdentity(document({ revision: '1', schema: 'future' }), STARTED_AT, 1)).toBe(false)
    expect(matchesSavedReceiptIdentity(document({ revision: '1', schema: '2' }), STARTED_AT, 1)).toBe(false)
  })

  it('rejects duplicate identity keys including case variants instead of taking the last value', () => {
    expect(matchesSavedReceiptIdentity(document({ extra: ['date: 2023-11-14T22:13:20.000Z'] }), STARTED_AT, 0)).toBe(
      false
    )
    expect(
      matchesSavedReceiptIdentity(
        document({ revision: '1', schema: '1', extra: ['TRANSCRIPTREVISION: 1'] }),
        STARTED_AT,
        1
      )
    ).toBe(false)
    expect(matchesSavedReceiptIdentity(document({ extra: ['TYPE: meeting-transcript'] }), STARTED_AT, 0)).toBe(false)
  })
})
