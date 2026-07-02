import { describe, it, expect } from 'vitest'
import { MeetingExtractionSchema, type MeetingExtraction } from './brain'
import { computeSilence } from './silence'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-07-02T12:00:00Z').getTime()
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10)

function meeting(p: {
  account: string
  date: string
  topics: string[]
  people?: string[]
  sentiment?: 'good' | 'mixed' | 'concerning'
}): MeetingExtraction {
  return MeetingExtractionSchema.parse({
    account: { name: p.account, sector: 'banking', sector_confidence: 'INFERRED', confidence: 'EXTRACTED' },
    date: p.date,
    source_file: `${p.date}.md`,
    topics: p.topics,
    people: (p.people ?? []).map((name) => ({ name, role: null, org: null, confidence: 'EXTRACTED' })),
    sentiment: p.sentiment ?? 'mixed'
  })
}

describe('computeSilence', () => {
  it('flags topics that were active in the prior window but absent from recent meetings', () => {
    const rows = [
      meeting({ account: 'Acme', date: iso(120), topics: ['pricing', 'migration', 'security'] }),
      meeting({ account: 'Acme', date: iso(90), topics: ['pricing', 'migration'] }),
      meeting({ account: 'Acme', date: iso(10), topics: ['pricing'] }) // recent: migration + security dropped
    ]
    const [sig] = computeSilence(rows, NOW)
    expect(sig.account).toBe('Acme')
    const dropped = sig.droppedTopics.map((d) => d.topic)
    expect(dropped).toContain('migration')
    expect(dropped).toContain('security')
    expect(dropped).not.toContain('pricing') // still live in the recent meeting
    // migration appeared in two prior meetings, security in one — persistence ranks migration first.
    expect(sig.droppedTopics[0].topic).toBe('migration')
    expect(sig.wentDark).toBe(false)
  })

  it('flags a champion who stopped appearing', () => {
    const rows = [
      meeting({ account: 'Acme', date: iso(100), topics: ['x'], people: ['Claire Dubois', 'Tom Reed'] }),
      meeting({ account: 'Acme', date: iso(80), topics: ['x'], people: ['Claire Dubois'] }),
      meeting({ account: 'Acme', date: iso(5), topics: ['x'], people: ['Tom Reed'] }) // Claire vanished
    ]
    const [sig] = computeSilence(rows, NOW)
    expect(sig.vanishedPeople).toContain('Claire Dubois')
    expect(sig.vanishedPeople).not.toContain('Tom Reed')
  })

  it('marks an account that went fully dark in the recent window', () => {
    const rows = [
      meeting({ account: 'Globex', date: iso(150), topics: ['renewal'] }),
      meeting({ account: 'Globex', date: iso(70), topics: ['renewal', 'expansion'] })
    ]
    const [sig] = computeSilence(rows, NOW)
    expect(sig.wentDark).toBe(true)
    expect(sig.daysQuiet).toBe(70)
    expect(sig.droppedTopics.map((d) => d.topic)).toEqual(expect.arrayContaining(['renewal', 'expansion']))
  })

  it('detects cooling sentiment from the prior window to the recent one', () => {
    const rows = [
      meeting({ account: 'Acme', date: iso(90), topics: ['x'], sentiment: 'good' }),
      meeting({ account: 'Acme', date: iso(70), topics: ['x'], sentiment: 'good' }),
      meeting({ account: 'Acme', date: iso(8), topics: ['x'], sentiment: 'concerning' })
    ]
    const [sig] = computeSilence(rows, NOW)
    expect(sig.cooling).toBe(true)
  })

  it('returns nothing for a healthy, consistent account (no false alarms)', () => {
    const rows = [
      meeting({ account: 'Acme', date: iso(60), topics: ['pricing'], people: ['Claire'], sentiment: 'good' }),
      meeting({ account: 'Acme', date: iso(10), topics: ['pricing'], people: ['Claire'], sentiment: 'good' })
    ]
    expect(computeSilence(rows, NOW)).toHaveLength(0)
  })

  it('needs at least two meetings and a prior-window meeting to say anything', () => {
    expect(computeSilence([meeting({ account: 'Solo', date: iso(3), topics: ['x'] })], NOW)).toHaveLength(0)
    // Two meetings, but both inside the recent window → no prior baseline to compare against.
    const bothRecent = [
      meeting({ account: 'New', date: iso(20), topics: ['a'] }),
      meeting({ account: 'New', date: iso(5), topics: ['a', 'b'] })
    ]
    expect(computeSilence(bothRecent, NOW)).toHaveLength(0)
  })

  it('ignores undated extractions and personal (accountless) chats', () => {
    const rows = [
      meeting({ account: 'Acme', date: '', topics: ['x'] }),
      MeetingExtractionSchema.parse({ account: null, date: iso(10), topics: ['personal'] })
    ]
    expect(computeSilence(rows, NOW)).toHaveLength(0)
  })

  it('orders fully-dark accounts first, then by how long they have been quiet', () => {
    const rows = [
      meeting({ account: 'Warm', date: iso(90), topics: ['a', 'b'] }),
      meeting({ account: 'Warm', date: iso(12), topics: ['a'] }), // dropped 'b', still active
      meeting({ account: 'ColdOld', date: iso(160), topics: ['a'] }),
      meeting({ account: 'ColdOld', date: iso(100), topics: ['a'] }), // dark, quiet 100d
      meeting({ account: 'ColdNew', date: iso(150), topics: ['a'] }),
      meeting({ account: 'ColdNew', date: iso(60), topics: ['a'] }) // dark, quiet 60d
    ]
    const order = computeSilence(rows, NOW).map((s) => s.account)
    expect(order.slice(0, 2)).toEqual(['ColdOld', 'ColdNew']) // dark first, longest-quiet leads
    expect(order[2]).toBe('Warm')
  })
})
