import { describe, expect, it } from 'vitest'
import { CONNECTOR_CATALOG, CONNECTOR_CATALOG_REVISION, catalogFingerprint, isWriteEffect } from './connector-catalog'

// Pinned per revision. Changing the catalog without bumping CONNECTOR_CATALOG_REVISION (and adding the new
// fingerprint here) fails this test: that is what keeps the revision monotonic and honest.
const PINNED: Record<number, string> = {
  1: [
    'outlook.calendar.today|outlook|read|Calendars.Read|tz|events',
    'outlook.draft.create|outlook|create|Mail.ReadWrite|body,subject|id',
    'outlook.event.create|outlook|create|Calendars.ReadWrite|body,endIso,startIso,subject|id'
  ].join('\n')
}

describe('connector catalog', () => {
  it('has a unique opId per operation and each op id is prefixed by its kind', () => {
    const ids = CONNECTOR_CATALOG.map((op) => op.opId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const op of CONNECTOR_CATALOG) expect(op.opId.startsWith(`${op.kind}.`)).toBe(true)
  })

  it('pins the fingerprint of the current revision', () => {
    expect(catalogFingerprint(CONNECTOR_CATALOG)).toBe(PINNED[CONNECTOR_CATALOG_REVISION])
  })

  it('keeps revisions monotonic and never skips a pinned one', () => {
    const revisions = Object.keys(PINNED)
      .map(Number)
      .sort((a, b) => a - b)
    expect(revisions[revisions.length - 1]).toBe(CONNECTOR_CATALOG_REVISION)
    expect(Number.isInteger(CONNECTOR_CATALOG_REVISION) && CONNECTOR_CATALOG_REVISION >= 1).toBe(true)
  })

  it('requires at least one scope per operation and classes only reads as non-writes', () => {
    for (const op of CONNECTOR_CATALOG) expect(op.scopes.length).toBeGreaterThan(0)
    expect(CONNECTOR_CATALOG.filter((op) => !isWriteEffect(op.effect)).map((op) => op.opId)).toEqual([
      'outlook.calendar.today'
    ])
  })
})
