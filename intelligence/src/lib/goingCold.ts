import type { BrainRead } from './brainAdapter.ts'
import { slug } from './slug.ts'

/**
 * Going-Cold engine (innovation #8) — the graph learns time.
 *
 * Every relationship node (person / account / deal) gets a freshness read from its own meeting
 * history: when it was last touched, how many days quiet, and a fresh / cooling / cold tier. The
 * graph fades what's going cold so entropy is VISIBLE, the rail names the coldest relationships
 * worth saving, and each row carries an honest re-engagement hook — an open commitment when one
 * exists (the strongest possible reopener: something already owed), otherwise the last real topic.
 *
 * Structural risk reads from the same graph: single-threaded deals (every deal at an account where
 * only one human is mapped hangs on one thread) and unmapped accounts (zero humans known — the
 * "unexplored region" the ideation doc called out). All facts, no predictions. Pure; `now` injected.
 */

const DAY = 24 * 60 * 60 * 1000
export type Freshness = 'fresh' | 'cooling' | 'cold'

export interface TouchInfo {
  lastTouch: string // ISO date of the most recent meeting ('' when none dated)
  daysQuiet: number
  freshness: Freshness
}

export interface ColdRailRow {
  nodeId: string
  label: string
  type: 'person' | 'account'
  account?: string
  daysQuiet: number
  hook: string // the drafted re-engagement move, grounded in ledger/topics — never invented
}

export interface GoingCold {
  /** node id → freshness (only nodes with at least one dated meeting appear). */
  touch: Map<string, TouchInfo>
  /** Coldest relationships first — people/accounts quiet ≥ cooling threshold. */
  rail: ColdRailRow[]
  /** Deal node ids whose account has ≤ 1 mapped person — the whole deal hangs on one thread. */
  singleThreaded: Set<string>
  /** Account node ids with zero mapped people — unexplored region. */
  unmapped: Set<string>
}

export const FRESH_DAYS = 14
export const COOLING_DAYS = 45

export function freshnessOf(daysQuiet: number): Freshness {
  if (daysQuiet <= FRESH_DAYS) return 'fresh'
  if (daysQuiet <= COOLING_DAYS) return 'cooling'
  return 'cold'
}


/**
 * Parses a leading `YYYY-MM-DD` off a date string as a UTC midnight timestamp, rejecting anything
 * that isn't a real calendar date (mirrors momentum.ts's / ledgerstats.ts's parseDateUTC — duplicated
 * rather than shared so this file stays a standalone, dependency-free unit like those two).
 */
function parseDateUTC(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const t = Date.UTC(year, month - 1, day)
  const check = new Date(t)
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  return t
}

function touchOf(meetings: Array<{ date: string; title?: string }> | undefined, now: number): TouchInfo | null {
  const dated = (meetings ?? []).filter((m) => m.date)
  if (dated.length === 0) return null
  const last = dated.reduce((a, b) => (a.date > b.date ? a : b))
  const t = parseDateUTC(last.date)
  if (t === null) return null
  const daysQuiet = Math.max(0, Math.floor((now - t) / DAY))
  return { lastTouch: last.date.slice(0, 10), daysQuiet, freshness: freshnessOf(daysQuiet) }
}

type Commitment = { text: string; by: string; status: string }

/** The strongest honest reopener: an open promise (owed either way) beats any invented icebreaker.
 *  `by` is a freeform LLM-written string (no enum — see brain.ts's LedgerCommitmentSchema), so the
 *  sentinel comparison against 'you'/'them' must be case-insensitive or a casing drift like "You"/"Them"
 *  either misses the yours-branch entirely or renders backwards grammar. Compare lowercased; display
 *  the ORIGINAL casing for a genuine named third party (never for the you/them sentinels themselves). */
function hookFor(openCommitments: Commitment[], lastTitle: string): string {
  const yours = openCommitments.find((c) => c.by.toLowerCase() === 'you')
  if (yours) return `You still owe them: ${yours.text}. Deliver it as the reopener.`
  const theirs = openCommitments[0]
  if (theirs) {
    const theirsIsThem = theirs.by.toLowerCase() === 'them'
    const who = theirsIsThem ? 'They' : theirs.by
    return `${who} still owe${theirsIsThem ? '' : 's'} you: ${theirs.text}. Chase it.`
  }
  return lastTitle ? `No open thread. Reopen with a value note on "${lastTitle}".` : 'No open thread. Reopen with a value note.'
}

export function buildGoingCold(b: BrainRead, now: number): GoingCold {
  const touch = new Map<string, TouchInfo>()
  const rail: ColdRailRow[] = []

  // Open commitments grouped by account (via that account's deals) — fuel for re-engagement hooks.
  const openByAccount = new Map<string, Commitment[]>()
  for (const d of b.deals) {
    // Legacy shape: a commitment written before `status` existed has no key at all — the schema
    // itself defaults a missing status to 'open' (LedgerCommitmentSchema, brain.ts), so mirror that
    // here rather than silently treating undefined as "not open".
    const open = (d.commitments ?? []).filter((c) => (c.status ?? 'open') === 'open')
    if (!open.length || !d.account) continue
    const key = slug(d.account)
    openByAccount.set(key, [...(openByAccount.get(key) ?? []), ...open])
  }

  for (const a of b.accounts) {
    const t = touchOf(a.meetings, now)
    if (!t) continue
    const id = `account:${slug(a.name)}`
    touch.set(id, t)
    if (t.freshness !== 'fresh') {
      const lastTitle = [...a.meetings].filter((m) => m.date).sort((x, y) => x.date.localeCompare(y.date)).pop()?.title ?? ''
      rail.push({
        nodeId: id,
        label: a.name,
        type: 'account',
        daysQuiet: t.daysQuiet,
        hook: hookFor(openByAccount.get(slug(a.name)) ?? [], lastTitle)
      })
    }
  }

  for (const p of b.people) {
    const t = touchOf(p.meetings, now)
    if (!t) continue
    const id = `person:${slug(p.name)}`
    touch.set(id, t)
    if (t.freshness !== 'fresh') {
      // A person's own open commitments beat the account-level pool as a reopener. Same legacy-status
      // fallback as the deal-level pool above.
      const own = (p.commitments ?? []).filter((c) => (c.status ?? 'open') === 'open')
      const pool = own.length ? own : p.account ? (openByAccount.get(slug(p.account)) ?? []) : []
      const lastTitle = [...(p.meetings ?? [])].filter((m) => m.date).sort((x, y) => x.date.localeCompare(y.date)).pop()?.title ?? ''
      rail.push({ nodeId: id, label: p.name, type: 'person', account: p.account ?? undefined, daysQuiet: t.daysQuiet, hook: hookFor(pool, lastTitle) })
    }
  }

  for (const d of b.deals) {
    const t = touchOf(d.meetings, now)
    if (t) touch.set(`deal:${slug(d.name)}`, t)
  }

  rail.sort((a, b2) => b2.daysQuiet - a.daysQuiet)

  // Structural risk: how many humans are mapped at each account? Keyed by slug, never by raw name.
  // `a.name`, `d.account` and `p.account` are three display strings frozen independently, at different
  // first-creation timestamps in ingest.ts, so casing and punctuation drift between two extractions of
  // the same company must still resolve to one account — the convention brainAdapter's accountSummaries
  // and AccountsView's dealsHere/peopleHere already follow. Joining on the raw lowercased string meant
  // "Acme Corp." and "Acme Corp" counted as two accounts, and this rail then reported the real one as
  // having nobody mapped: a false "unmapped" badge and a false "single-threaded" risk on a healthy
  // account, on the panel a user reads to decide who to call.
  const peopleAtAccount = new Map<string, number>()
  for (const p of b.people) {
    if (!p.account) continue
    const k = slug(p.account)
    peopleAtAccount.set(k, (peopleAtAccount.get(k) ?? 0) + 1)
  }
  const singleThreaded = new Set<string>()
  for (const d of b.deals) {
    if (d.outcome !== 'open' || !d.account) continue
    if ((peopleAtAccount.get(slug(d.account)) ?? 0) <= 1) singleThreaded.add(`deal:${slug(d.name)}`)
  }
  const unmapped = new Set<string>()
  for (const a of b.accounts) {
    if ((peopleAtAccount.get(slug(a.name)) ?? 0) === 0) unmapped.add(`account:${slug(a.name)}`)
  }

  return { touch, rail, singleThreaded, unmapped }
}
