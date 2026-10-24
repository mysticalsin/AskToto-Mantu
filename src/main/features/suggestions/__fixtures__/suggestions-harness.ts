import type { Evidence } from '../model'
import type { ResearchSource, SourceItem } from '../sources'
import { createSuggestionService, type SuggestionAuditRecord } from '../service'
import { createSuggestionStore, type SuggestionFileIo, type SuggestionScope } from '../store'

export const KEY_A = 'a'.repeat(64)
export const KEY_B = 'b'.repeat(64)
export const TENANT_1 = '1'.repeat(64)
export const TENANT_2 = '2'.repeat(64)
export const NOW = Date.parse('2026-10-24T12:00:00Z')
export const HOUR = 3_600_000
export const DAY = 24 * HOUR

export const scopeOf = (ownerKey: string, tenantKey: string): SuggestionScope => ({
  partitionId: `${ownerKey.slice(0, 2)}${tenantKey.slice(0, 2)}`.repeat(6),
  ownerKey,
  tenantKey
})

/** A reversible, non-plaintext seal: enough to prove nothing readable reaches the io. */
export const seal = (plain: string): Buffer => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a))
export const open = (sealed: Buffer): string => {
  if (sealed.length === 0) throw new Error('empty')
  return Buffer.from(sealed.map((byte) => byte ^ 0x5a)).toString('utf8')
}

export interface MemoryIo extends SuggestionFileIo {
  files: Map<string, Buffer>
  writes: number
  /** While set, reads wait for it: the store queue is busy, so a run is honestly `queued`. */
  readGate: Promise<void> | null
  onWrite: (() => void) | null
}

export function memoryIo(): MemoryIo {
  const files = new Map<string, Buffer>()
  const io: MemoryIo = {
    files,
    writes: 0,
    readGate: null,
    onWrite: null,
    async read(partitionId) {
      if (io.readGate) await io.readGate
      return files.get(partitionId) ?? null
    },
    async write(partitionId, data) {
      io.writes += 1
      io.onWrite?.()
      files.set(partitionId, data)
    }
  }
  return io
}

export const ref = (kind: 'calendar' | 'memory', n: number): Evidence['ref'] =>
  kind === 'calendar'
    ? { accountRef: `acct_${n}`, eventKey: `e${n}`.padEnd(8, '0') }
    : { memoryId: n.toString(16).padStart(32, '0'), sourceId: 'preference' }

export function evidence(
  kind: 'calendar' | 'memory',
  n: number,
  label: string,
  terms: string[],
  eventAt: number | null,
  retrievedAt = NOW
): Evidence {
  return { sourceKind: kind, ref: ref(kind, n), label, terms, eventAt, retrievedAt } as Evidence
}

export const anchor = (n: number, label: string, terms: string[], eventAt = NOW + HOUR): SourceItem => ({
  role: 'anchor',
  evidence: evidence('calendar', n, label, terms, eventAt)
})
export const support = (n: number, label: string, terms: string[], eventAt: number | null = null): SourceItem => ({
  role: 'support',
  evidence: evidence('memory', n, label, terms, eventAt)
})

export interface FakeSource extends ResearchSource {
  items: SourceItem[]
  valid: boolean
  calls: number
  active: number
  maxActive: number
  throws: boolean
  skipped: boolean
  ms: number
}

export function fakeSource(kind: 'calendar' | 'memory', items: SourceItem[], clock?: { now: number }): FakeSource {
  const source: FakeSource = {
    kind,
    items,
    valid: true,
    calls: 0,
    active: 0,
    maxActive: 0,
    throws: false,
    skipped: false,
    ms: 0,
    async gather() {
      source.calls += 1
      source.active += 1
      source.maxActive = Math.max(source.maxActive, source.active)
      await Promise.resolve()
      await Promise.resolve()
      source.active -= 1
      if (clock) clock.now += source.ms
      if (source.throws) throw new Error('boom')
      return source.skipped ? { status: 'skipped' } : { status: 'ok', items: source.items }
    },
    async stillValid() {
      return source.valid
    }
  }
  return source
}

export function harness(scope: SuggestionScope | null = scopeOf(KEY_A, TENANT_1)) {
  const io = memoryIo()
  const current = { scope }
  const clock = { now: NOW }
  const flags = { enabled: true }
  const notifications: Array<{ title: string; body: string; directRequest: boolean }> = []
  const audits: SuggestionAuditRecord[] = []
  let counter = 0
  const store = createSuggestionStore({ io, seal, open, scope: () => current.scope })
  const calendar = fakeSource('calendar', [anchor(1, 'Budget review', ['budget', 'review', 'forecast'])], clock)
  const memory = fakeSource(
    'memory',
    [support(2, 'Prefers forecast numbers first', ['forecast', 'budget', 'numbers'])],
    clock
  )
  const newService = (sources: readonly ResearchSource[] = [calendar, memory]) =>
    createSuggestionService({
      store,
      scope: () => current.scope,
      enabled: () => flags.enabled,
      sources,
      now: () => clock.now,
      newId: () => (++counter).toString(16).padStart(24, '0'),
      newNonce: () => (++counter).toString(16).padStart(32, 'f'),
      notify: (n) => void notifications.push(n),
      audit: (record) => void audits.push(record)
    })
  return { io, current, clock, flags, notifications, audits, store, calendar, memory, newService }
}
