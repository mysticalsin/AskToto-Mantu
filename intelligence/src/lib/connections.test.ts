import { describe, expect, it } from 'vitest'
import { buildMeetingConnections, type ConnectionsInput } from './connections'
import { slug } from './slug'

function base(): ConnectionsInput {
  return {
    people: [],
    accounts: [],
    deals: [],
    meetings_feed: [
      { slug: slug('meetings/a.md'), title24: 'Kickoff', date: '2026-09-01', topics: ['renewal'] },
      { slug: slug('meetings/b.md'), title24: 'Follow-up', date: '2026-09-10', topics: ['renewal', 'pricing'] },
      { slug: slug('meetings/c.md'), title24: 'Internal', date: '2026-09-05', topics: ['ops'] }
    ]
  }
}

describe('buildMeetingConnections', () => {
  it('links meetings that share a topic from the feed', () => {
    expect(buildMeetingConnections(base())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'topic',
          via: 'renewal',
          a: expect.objectContaining({ title: 'Kickoff' }),
          b: expect.objectContaining({ title: 'Follow-up' })
        })
      ])
    )
  })

  it('links two meetings that share a person (bidirectional readable row)', () => {
    const data = base()
    data.people = [
      {
        slug: 'sophie-martin',
        name: 'Sophie Martin',
        meetings: [
          { file: 'meetings/a.md', date: '2026-09-01', title: 'Kickoff' },
          { file: 'meetings/b.md', date: '2026-09-10', title: 'Follow-up' }
        ]
      }
    ]
    const rows = buildMeetingConnections(data)
    const person = rows.find((r) => r.kind === 'person' && r.via === 'Sophie Martin')
    expect(person).toBeTruthy()
    expect(person!.a.title).toBe('Kickoff')
    expect(person!.b.title).toBe('Follow-up')
    expect(person!.a.slug).not.toBe(person!.b.slug)
  })

  it('links meetings that share an account', () => {
    const data = base()
    data.accounts = [
      {
        slug: 'acme',
        name: 'Acme',
        meetings: [
          { file: 'meetings/a.md', date: '2026-09-01', title: 'Kickoff' },
          { file: 'meetings/b.md', date: '2026-09-10', title: 'Follow-up' }
        ]
      }
    ]
    const row = buildMeetingConnections(data).find((r) => r.kind === 'account' && r.via === 'Acme')
    expect(row).toMatchObject({
      a: { title: 'Kickoff' },
      b: { title: 'Follow-up' }
    })
  })

  it('dedupes the same pair+kind+via', () => {
    const data = base()
    data.people = [
      {
        slug: 'p',
        name: 'Pat',
        meetings: [
          { file: 'meetings/a.md', date: '2026-09-01', title: 'Kickoff' },
          { file: 'meetings/b.md', date: '2026-09-10', title: 'Follow-up' },
          { file: 'meetings/a.md', date: '2026-09-01', title: 'Kickoff' }
        ]
      }
    ]
    const people = buildMeetingConnections(data).filter((r) => r.kind === 'person')
    expect(people).toHaveLength(1)
  })

  it('does not invent a self-link for a single-meeting entity', () => {
    const data = base()
    data.people = [
      {
        slug: 'solo',
        name: 'Solo',
        meetings: [{ file: 'meetings/a.md', date: '2026-09-01', title: 'Kickoff' }]
      }
    ]
    expect(buildMeetingConnections(data).filter((r) => r.kind === 'person')).toEqual([])
  })

  it('honours the limit', () => {
    const data = base()
    data.people = [
      {
        slug: 'busy',
        name: 'Busy',
        meetings: [
          { file: 'meetings/a.md', date: '2026-09-01', title: 'Kickoff' },
          { file: 'meetings/b.md', date: '2026-09-10', title: 'Follow-up' },
          { file: 'meetings/c.md', date: '2026-09-05', title: 'Internal' }
        ]
      }
    ]
    expect(buildMeetingConnections(data, 2)).toHaveLength(2)
  })
})
