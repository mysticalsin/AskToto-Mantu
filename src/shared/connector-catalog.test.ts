import { describe, expect, it } from 'vitest'
import { allowedClassesFor } from './connector-effects'
import { CONNECTOR_CATALOG, CONNECTOR_CATALOG_REVISION, catalogFingerprint, isWriteEffect } from './connector-catalog'

// Pinned per revision. Changing the catalog without bumping CONNECTOR_CATALOG_REVISION (and adding the new
// fingerprint here) fails this test: that is what keeps the revision monotonic and honest.
const PINNED: Record<number, string> = {
  1: [
    'outlook.calendar.today|outlook|read|Calendars.Read|tz|events',
    'outlook.draft.create|outlook|create|Mail.ReadWrite|body,subject|id',
    'outlook.event.create|outlook|create|Calendars.ReadWrite|body,endIso,startIso,subject|id'
  ].join('\n'),
  2: [
    'outlook.calendar.today|outlook|read|Calendars.Read|tz|events',
    'outlook.draft.create|outlook|create|Mail.ReadWrite|body,subject|id',
    'outlook.event.create|outlook|create|Calendars.ReadWrite|body,endIso,startIso,subject|endIso,id,startIso,verified'
  ].join('\n'),
  3: [
    'outlook.calendar.today|outlook|read|read|Calendars.Read|tz|events',
    'outlook.draft.create|outlook|create|reversible_write|Mail.ReadWrite|body,subject|id',
    'outlook.event.create|outlook|create|reversible_write|Calendars.ReadWrite|body,endIso,startIso,subject|endIso,id,startIso,verified'
  ].join('\n'),
  4: [
    'apple.calendar.event.create|apple_calendar|create|reversible_write|EventKit.FullAccess|body,endIso,startIso,subject|endIso,id,startIso,verified',
    'outlook.calendar.today|outlook|read|read|Calendars.Read|tz|events',
    'outlook.draft.create|outlook|create|reversible_write|Mail.ReadWrite|body,subject|id',
    'outlook.event.create|outlook|create|reversible_write|Calendars.ReadWrite|body,endIso,startIso,subject|endIso,id,startIso,verified'
  ].join('\n')
}

describe('connector catalog', () => {
  it('has a unique opId per operation and each op id is prefixed by its kind', () => {
    const ids = CONNECTOR_CATALOG.map((op) => op.opId)
    expect(new Set(ids).size).toBe(ids.length)
    // `apple_calendar` ops read `apple.calendar.…`: the kind's underscore is the op id's dot.
    for (const op of CONNECTOR_CATALOG)
      expect(op.opId.startsWith(`${op.kind.replace('_', '.')}.`) || op.opId.startsWith(`${op.kind}.`)).toBe(true)
  })

  it('lists apple.calendar.event.create as a write that requires start and end', () => {
    const op = CONNECTOR_CATALOG.find((o) => o.opId === 'apple.calendar.event.create')
    expect(op?.kind).toBe('apple_calendar')
    expect(op && isWriteEffect(op.effect)).toBe(true)
    expect(op?.input.safeParse({ subject: 'x' }).success).toBe(false)
    expect(
      op?.input.safeParse({ subject: 'x', startIso: '2026-10-25T10:00:00Z', endIso: '2026-10-25T11:00:00Z' }).success
    ).toBe(true)
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

  it('every catalog op declares an effectClass allowed for its effect', () => {
    for (const op of CONNECTOR_CATALOG) expect(allowedClassesFor(op.effect)).toContain(op.effectClass)
    expect(CONNECTOR_CATALOG_REVISION).toBe(4)
  })

  it('Apple Calendar create is a reversible write: the owner can delete the event in Calendar', () => {
    const op = CONNECTOR_CATALOG.find((o) => o.opId === 'apple.calendar.event.create')
    expect(op?.effectClass).toBe('reversible_write')
  })

  it('requires at least one scope per operation and classes only reads as non-writes', () => {
    for (const op of CONNECTOR_CATALOG) expect(op.scopes.length).toBeGreaterThan(0)
    expect(CONNECTOR_CATALOG.filter((op) => !isWriteEffect(op.effect)).map((op) => op.opId)).toEqual([
      'outlook.calendar.today'
    ])
  })
})
