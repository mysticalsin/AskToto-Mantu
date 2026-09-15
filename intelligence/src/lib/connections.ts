/**
 * Cross-meeting Connections — concrete Meeting A ↔ Meeting B rows from shared
 * people / accounts / deals / topics (MANTU-INTELLIGENCE.md acceptance #3).
 *
 * Pure + dependency-light: only reads already-extracted entity meeting refs and
 * the meetings feed. Never invents edges from embeddings or similarity scores.
 */
import { slug } from './slug.ts'

export type ConnectionKind = 'person' | 'account' | 'deal' | 'topic'

export interface ConnectionMeetingRef {
  slug: string
  title: string
  date: string
}

export interface MeetingConnection {
  /** Stable id for list keys — sorted meeting pair + kind + via slug. */
  id: string
  kind: ConnectionKind
  /** Display name of the shared entity (person/account/deal/topic). */
  via: string
  viaSlug: string
  a: ConnectionMeetingRef
  b: ConnectionMeetingRef
}

export interface ConnectionsInput {
  people: Array<{
    slug: string
    name: string
    meetings: Array<{ file: string; date: string; title: string }>
  }>
  accounts: Array<{
    slug: string
    name: string
    meetings: Array<{ file: string; date: string; title: string }>
  }>
  deals: Array<{
    bid_id: string
    display_name: string
    meetings: Array<{ file: string; date: string; title: string }>
  }>
  meetings_feed: Array<{
    slug: string
    title24: string
    date: string
    topics: string[]
  }>
}

function meetingKey(fileOrSlug: string): string {
  // Entity meeting refs use source_file; feed rows use slug(source_file).
  return slug(fileOrSlug)
}

function resolveMeeting(
  fileOrSlug: string,
  bySlug: Map<string, ConnectionsInput['meetings_feed'][number]>,
  fallbackTitle?: string,
  fallbackDate?: string
): ConnectionMeetingRef | null {
  const key = meetingKey(fileOrSlug)
  const feed = bySlug.get(key)
  if (feed) {
    return { slug: feed.slug, title: feed.title24, date: feed.date }
  }
  const bare = (fallbackTitle || fileOrSlug.split(/[/\\]/).pop() || fileOrSlug)
    .replace(/\.md$/i, '')
    .trim()
  if (!bare) return null
  return { slug: key, title: bare, date: fallbackDate || '' }
}

/**
 * Build undirected meeting↔meeting connections. One row per (pair, kind, via).
 * Ranked: newer pair first (max date), then kind order person→account→deal→topic, then via label.
 */
export function buildMeetingConnections(data: ConnectionsInput, limit = 100): MeetingConnection[] {
  const bySlug = new Map(data.meetings_feed.map((m) => [m.slug, m]))
  const seen = new Set<string>()
  const out: MeetingConnection[] = []

  const addPair = (
    kind: ConnectionKind,
    via: string,
    viaSlug: string,
    left: { file: string; date: string; title: string },
    right: { file: string; date: string; title: string }
  ): void => {
    const aKey = meetingKey(left.file)
    const bKey = meetingKey(right.file)
    if (aKey === bKey) return
    const [lo, hi] = aKey < bKey ? [aKey, bKey] : [bKey, aKey]
    const id = `${kind}:${viaSlug}:${lo}:${hi}`
    if (seen.has(id)) return
    const ma = resolveMeeting(left.file, bySlug, left.title, left.date)
    const mb = resolveMeeting(right.file, bySlug, right.title, right.date)
    if (!ma || !mb) return
    // Chronological display when both dates exist; else keep discovery order.
    const [first, second] =
      ma.date && mb.date && mb.date < ma.date ? [mb, ma] : [ma, mb]
    seen.add(id)
    out.push({ id, kind, via, viaSlug, a: first, b: second })
  }

  const expandEntity = (
    kind: ConnectionKind,
    via: string,
    viaSlug: string,
    meetings: Array<{ file: string; date: string; title: string }>
  ): void => {
    const refs = (meetings ?? []).filter((m) => m.file)
    for (let i = 0; i < refs.length; i++) {
      for (let j = i + 1; j < refs.length; j++) {
        addPair(kind, via, viaSlug, refs[i], refs[j])
      }
    }
  }

  for (const p of data.people) {
    expandEntity('person', p.name, p.slug, p.meetings ?? [])
  }
  for (const a of data.accounts) {
    expandEntity('account', a.name, a.slug, a.meetings ?? [])
  }
  for (const d of data.deals) {
    expandEntity('deal', d.display_name, d.bid_id, d.meetings ?? [])
  }

  const topicToMeetings = new Map<string, ConnectionsInput['meetings_feed']>()
  for (const m of data.meetings_feed) {
    for (const raw of m.topics ?? []) {
      const t = raw.trim()
      if (!t) continue
      const key = t.toLowerCase()
      let list = topicToMeetings.get(key)
      if (!list) {
        list = []
        topicToMeetings.set(key, list)
      }
      list.push(m)
    }
  }
  for (const [topicKey, meetings] of topicToMeetings) {
    if (meetings.length < 2) continue
    const label =
      meetings[0].topics.find((t) => t.trim().toLowerCase() === topicKey)?.trim() || topicKey
    const viaSlug = slug(label)
    for (let i = 0; i < meetings.length; i++) {
      for (let j = i + 1; j < meetings.length; j++) {
        addPair(
          'topic',
          label,
          viaSlug,
          { file: meetings[i].slug, date: meetings[i].date, title: meetings[i].title24 },
          { file: meetings[j].slug, date: meetings[j].date, title: meetings[j].title24 }
        )
      }
    }
  }

  const kindRank: Record<ConnectionKind, number> = {
    person: 0,
    account: 1,
    deal: 2,
    topic: 3
  }
  out.sort((x, y) => {
    // ISO date strings — lexicographic max is chronological max.
    const xd = x.a.date >= x.b.date ? x.a.date : x.b.date
    const yd = y.a.date >= y.b.date ? y.a.date : y.b.date
    if (xd !== yd) return yd < xd ? -1 : 1
    if (kindRank[x.kind] !== kindRank[y.kind]) return kindRank[x.kind] - kindRank[y.kind]
    return x.via.localeCompare(y.via) || x.id.localeCompare(y.id)
  })

  return out.slice(0, limit)
}

export function connectionKindLabel(kind: ConnectionKind): string {
  return kind
}
