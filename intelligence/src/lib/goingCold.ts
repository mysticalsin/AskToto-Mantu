import type { BrainRead } from './brainAdapter'

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

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'

function touchOf(meetings: Array<{ date: string; title?: string }> | undefined, now: number): TouchInfo | null {
  const dated = (meetings ?? []).filter((m) => m.date)
  if (dated.length === 0) return null
  const last = dated.reduce((a, b) => (a.date > b.date ? a : b))
  const t = new Date(last.date).getTime()
  if (!Number.isFinite(t)) return null
  const daysQuiet = Math.max(0, Math.floor((now - t) / DAY))
  return { lastTouch: last.date.slice(0, 10), daysQuiet, freshness: freshnessOf(daysQuiet) }
}

type Commitment = { text: string; by: string; status: string }

/** The strongest honest reopener: an open promise (owed either way) beats any invented icebreaker. */
function hookFor(openCommitments: Commitment[], lastTitle: string): string {
  const yours = openCommitments.find((c) => c.by === 'you')
  if (yours) return `You still owe them: ${yours.text} — deliver it as the reopener.`
  const theirs = openCommitments[0]
  if (theirs) {
    const who = theirs.by === 'them' ? 'They' : theirs.by
    return `${who} still owe${theirs.by === 'them' ? '' : 's'} you: ${theirs.text} — chase it.`
  }
  return lastTitle ? `No open thread — reopen with a value note on "${lastTitle}".` : 'No open thread — reopen with a value note.'
}

export function buildGoingCold(b: BrainRead, now: number): GoingCold {
  const touch = new Map<string, TouchInfo>()
  const rail: ColdRailRow[] = []

  // Open commitments grouped by account (via that account's deals) — fuel for re-engagement hooks.
  const openByAccount = new Map<string, Commitment[]>()
  for (const d of b.deals) {
    const open = (d.commitments ?? []).filter((c) => c.status === 'open')
    if (!open.length || !d.account) continue
    const key = d.account.toLowerCase()
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
        hook: hookFor(openByAccount.get(a.name.toLowerCase()) ?? [], lastTitle)
      })
    }
  }

  for (const p of b.people) {
    const t = touchOf(p.meetings, now)
    if (!t) continue
    const id = `person:${slug(p.name)}`
    touch.set(id, t)
    if (t.freshness !== 'fresh') {
      // A person's own open commitments beat the account-level pool as a reopener.
      const own = (p.commitments ?? []).filter((c) => c.status === 'open')
      const pool = own.length ? own : p.account ? (openByAccount.get(p.account.toLowerCase()) ?? []) : []
      const lastTitle = [...(p.meetings ?? [])].filter((m) => m.date).sort((x, y) => x.date.localeCompare(y.date)).pop()?.title ?? ''
      rail.push({ nodeId: id, label: p.name, type: 'person', account: p.account ?? undefined, daysQuiet: t.daysQuiet, hook: hookFor(pool, lastTitle) })
    }
  }

  for (const d of b.deals) {
    const t = touchOf(d.meetings, now)
    if (t) touch.set(`deal:${slug(d.name)}`, t)
  }

  rail.sort((a, b2) => b2.daysQuiet - a.daysQuiet)

  // Structural risk: how many humans are mapped at each account?
  const peopleAtAccount = new Map<string, number>()
  for (const p of b.people) {
    if (!p.account) continue
    const k = p.account.toLowerCase()
    peopleAtAccount.set(k, (peopleAtAccount.get(k) ?? 0) + 1)
  }
  const singleThreaded = new Set<string>()
  for (const d of b.deals) {
    if (d.outcome !== 'open' || !d.account) continue
    if ((peopleAtAccount.get(d.account.toLowerCase()) ?? 0) <= 1) singleThreaded.add(`deal:${slug(d.name)}`)
  }
  const unmapped = new Set<string>()
  for (const a of b.accounts) {
    if ((peopleAtAccount.get(a.name.toLowerCase()) ?? 0) === 0) unmapped.add(`account:${slug(a.name)}`)
  }

  return { touch, rail, singleThreaded, unmapped }
}
