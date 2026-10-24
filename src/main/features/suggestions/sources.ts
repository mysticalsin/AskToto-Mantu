import type { AccountRef, ConnectorKind } from '@shared/connector-catalog'
import type { UserMemoryList } from '@shared/user-memory'
import { EVIDENCE_LABEL_MAX } from '@shared/suggestions'
import { actionDigest } from '../../action-guard'
import { termsOf } from './editor'
import type { Evidence, EvidenceKind, SourceItem } from './model'
import type { ReadOnlyConnectorPort } from './read-only-port'

export type { SourceItem } from './model'

export type GatherResult = { status: 'ok'; items: SourceItem[] } | { status: 'skipped' }

/**
 * A place the pipeline may read from. A source only reads what the owner already granted. `gather` returns `skipped`
 * when there is nothing to read (no account, no memory, not available) and throws on a real failure. `stillValid`
 * is asked again at accept time: the source must still be granted, connected and un-deleted.
 */
export interface ResearchSource {
  readonly kind: EvidenceKind
  gather(ctx: { signal: AbortSignal; now: number }): Promise<GatherResult>
  stillValid(evidence: Evidence): Promise<boolean>
}

const label = (text: string): string => (text.trim() || '(untitled)').slice(0, EVIDENCE_LABEL_MAX)

/** Refusals that mean "this account cannot be read right now" rather than "the read broke". */
const NOT_READABLE = new Set(['account_unavailable', 'account_not_ready', 'grant_stale'])

export interface CalendarSourceDeps {
  port: ReadOnlyConnectorPort
  accounts: {
    current(kind: ConnectorKind): Promise<AccountRef | null>
    /** Whether the account is still readable (G60/G61 readiness for `read`). */
    ready(kind: ConnectorKind, ref: AccountRef): boolean
  }
  tz: string
}

/** Today's calendar events through the read-only connector port. The event title is kept as a short label and as terms. */
export function calendarSource(deps: CalendarSourceDeps): ResearchSource {
  return {
    kind: 'calendar',
    async gather({ now }) {
      const account = await deps.accounts.current('outlook')
      if (!account) return { status: 'skipped' }
      const result = await deps.port.read('outlook.calendar.today', { tz: deps.tz }, account)
      if (!result.ok) {
        if (NOT_READABLE.has(result.reason)) return { status: 'skipped' }
        throw new Error('calendar read failed')
      }
      const events = (result.output as { events?: Array<{ subject?: unknown; start?: unknown }> }).events ?? []
      const items: SourceItem[] = []
      for (const event of events) {
        const subject = typeof event.subject === 'string' ? event.subject : ''
        const start = typeof event.start === 'string' ? Date.parse(event.start) : Number.NaN
        if (!Number.isFinite(start)) continue
        items.push({
          role: 'anchor',
          evidence: {
            sourceKind: 'calendar',
            ref: { accountRef: account, eventKey: actionDigest({ subject, start }).slice(0, 16) },
            label: label(subject),
            terms: termsOf(subject),
            eventAt: start,
            retrievedAt: now
          }
        })
      }
      return { status: 'ok', items }
    },
    async stillValid(evidence) {
      return evidence.sourceKind === 'calendar' && deps.accounts.ready('outlook', evidence.ref.accountRef as AccountRef)
    }
  }
}

export interface MemorySourceDeps {
  memory(): { list(): Promise<UserMemoryList> } | null
  now(): number
}

/** What the owner told Métis to remember (G57). Only terms and a short label are kept; the memory stays where it is. */
export function memorySource(deps: MemorySourceDeps): ResearchSource {
  const read = async (): Promise<UserMemoryList | null> => {
    const memory = deps.memory()
    if (!memory) return null
    const list = await memory.list()
    return list.status === 'ok' ? list : null
  }
  return {
    kind: 'memory',
    async gather({ now }) {
      const list = await read()
      if (!list) return { status: 'skipped' }
      return {
        status: 'ok',
        items: list.items.map((item) => ({
          role: 'support' as const,
          evidence: {
            sourceKind: 'memory' as const,
            ref: { memoryId: item.id, sourceId: item.kind },
            label: label(item.text),
            terms: termsOf(item.text),
            eventAt: item.at,
            retrievedAt: now
          }
        }))
      }
    },
    async stillValid(evidence) {
      if (evidence.sourceKind !== 'memory') return false
      const list = await read()
      const found = list?.items.find((item) => item.id === evidence.ref.memoryId)
      return found !== undefined && (found.expiresAt === null || found.expiresAt > deps.now())
    }
  }
}
