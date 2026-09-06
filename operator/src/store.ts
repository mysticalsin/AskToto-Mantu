import { type CrmSendRow } from './crm'
import { applyPulse, isSessionStale, type PulseKind, type SessionRow as SessionState } from './sessions'

export interface IssuedLicenseRow {
  jti: string
  last4: string
  key_hash: string
  days: number
  iat: number
  exp: number
  revoked: number
  created_at: number
  created_by: string | null
  /** Group/tier issuance (section 9c). null on every license minted before Groups shipped. */
  group_id?: string | null
  tier?: string | null
  /** Who it was issued to: an email or a device id, set by the Groups license-generate flow. */
  member?: string | null
  activated_device?: string | null
  activated_at?: number | null
  /** Set to `'declined'` by the review queue's "let it expire" action (plan 6.7 block 0, B11); never
   *  written anywhere else, never changes `exp` or `revoked` on its own. */
  renewal_note?: string | null
}

export interface SeatRow {
  device_id: string
  seat_hash: string
  os: string
  app_version: string
  first_seen: number
  last_seen: number
  country: string | null
  city: string | null
  region?: string | null
  lat: number | null
  lon: number | null
  last_index_at: number | null
  hostname: string | null
  sso_email: string | null
  license: string | null
  approval?: string | null
  license_jti?: string | null
}

export interface EventRow {
  id: string
  ts: number
  kind: string
  actor: string | null
  device_id: string | null
  country: string | null
  detail: string | null
  /** Lets a plain EventRow[] be handed to a generic Record<string, unknown>[] consumer (CSV export). */
  [key: string]: unknown
}

/** Extra filters resolved against the seat joined by device_id, not stored on the event itself. */
export interface EventsQueryOpts {
  since?: number
  until?: number
  kinds?: string[]
  deviceId?: string
  country?: string
  os?: string
  version?: string
  q?: string
  cursor?: string
  limit?: number
}

export interface EventsPage {
  rows: EventRow[]
  nextCursor: string | null
}

export interface VaultKeyMeta {
  id: string
  provider: string
  label: string
  last4: string
  status: string
  createdAt: number
  rotatedAt: number | null
  revokedAt: number | null
}

export interface VaultKeyRow {
  id: string
  provider: string
  label: string
  last4: string
  cipher: string
  iv: string
  status: string
  created_at: number
  created_by: string
  rotated_at: number | null
  revoked_at: number | null
}

export interface AskRow {
  id: string
  device_id: string
  ts: number
  mode: string | null
  skill_id: string | null
  skill_version: string | null
  provider: string | null
  model: string | null
  ttft_ms: number | null
  total_ms: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read: number | null
  cache_write: number | null
  cache_uncached: number | null
  cache_status: string | null
  cache_ttl: string | null
  outcome: string | null
  rating: string | null
  prompt_cipher: string | null
  prompt_iv: string | null
  preview: string | null
  /**
   * Closed-taxonomy label from src/shared/question-type.ts, normalized on ingest. null = the seat
   * never sent one (pre-type build or the D1 column is not migrated yet), never free text.
   */
  question_type: string | null
}

export interface PulseRow {
  id: string
  device_id: string
  ts: number
  kind: 'heartbeat' | 'ask'
  country: string | null
  city: string | null
  region?: string | null
}

export interface ProposalRow {
  id: string
  skill_id: string
  from_version: string
  evidence_json: string
  diff: string
  rationale: string
  status: string
  created_by: string
  created_at: number
  decided_at: number | null
  reject_reason: string | null
}

export interface PackRow {
  id: string
  skill_id: string
  version: string
  sha256: string
  body: string
  signed: string
  pushed_at: number
  pushed_by: string
}

/** packs without the (potentially large) signed body, for bounded dashboard reads. */
export type PackMeta = Omit<PackRow, 'body'>

export interface AuditRow {
  ts: number
  actor: string
  action: string
  ask_id: string | null
  detail: string
  request_id: string | null
  route: string | null
  /** Lets a plain AuditRow[] be handed to a generic Record<string, unknown>[] consumer (CSV export). */
  [key: string]: unknown
}

export interface AuditQueryOpts {
  since?: number
  actor?: string
  action?: string
}

export type { SessionState as SessionRow }

export interface SessionsQueryOpts {
  since?: number
  until?: number
  deviceId?: string
  cursor?: string
  limit: number
}

export interface SessionsPage {
  rows: SessionState[]
  nextCursor: string | null
}

export interface SessionDetail {
  session: SessionState
  pulses: PulseRow[]
}

export interface GroupRow {
  id: string
  name: string
  tier: string
  notes: string | null
  created_at: number
  created_by: string | null
}

export type GroupMemberKind = 'email' | 'device'

export interface GroupMemberRow {
  group_id: string
  member: string
  kind: GroupMemberKind
  added_at: number
  added_by: string | null
}

export interface TierRow {
  id: string
  label: string
  entitlements_json: string
  updated_at: number
}

/** Métis / Métis Light defaults (section 9c), editable afterward in Settings -> Tiers. */
export const DEFAULT_TIER_ENTITLEMENTS: Record<string, string[]> = {
  metis: ['ask', 'listen', 'recap', 'crm_push', 'operator_keys', 'intelligence', 'integrations'],
  'metis-light': ['ask', 'intelligence']
}

export function defaultTiers(now: number): TierRow[] {
  return Object.entries(DEFAULT_TIER_ENTITLEMENTS).map(([id, entitlements]) => ({
    id,
    label: id === 'metis' ? 'Métis' : 'Métis Light',
    entitlements_json: JSON.stringify(entitlements),
    updated_at: now
  }))
}

export interface IntegrationRow {
  id: string
  kind: string
  label: string
  base_url: string | null
  cipher: string | null
  iv: string | null
  last4: string | null
  scope_json: string
  status: string
  created_at: number
  created_by: string | null
  rotated_at: number | null
  revoked_at: number | null
  last_used_at: number | null
  uses: number
}

export type IntegrationMeta = Omit<IntegrationRow, 'cipher' | 'iv'>

export function toIntegrationMeta(row: IntegrationRow): IntegrationMeta {
  const { cipher: _cipher, iv: _iv, ...meta } = row
  return meta
}

export interface IntegrationGrantRow {
  id: string
  integration_id: string
  device_id: string
  ts: number
}

export interface OperatorStore {
  takeNonce(nonce: string, ts: number): Promise<boolean>
  hitRate(deviceId: string, now: number, windowMs: number, max: number): Promise<boolean>
  upsertSeat(row: SeatRow): Promise<void>
  updateSeatApproval(deviceId: string, approval: string): Promise<boolean>
  getSeat(deviceId: string): Promise<SeatRow | null>
  insertAsk(row: AskRow): Promise<void>
  updateAskRating(id: string, rating: string): Promise<void>
  listAsks(limit: number, since?: number): Promise<AskRow[]>
  getAsk(id: string): Promise<AskRow | null>
  listSeats(): Promise<SeatRow[]>
  insertPulse(row: PulseRow): Promise<void>
  listPulses(since: number): Promise<PulseRow[]>
  listProposals(limit?: number): Promise<ProposalRow[]>
  getProposal(id: string): Promise<ProposalRow | null>
  putProposal(row: ProposalRow): Promise<void>
  listPacks(): Promise<PackMeta[]>
  latestPacks(): Promise<PackMeta[]>
  putPack(row: PackRow): Promise<void>
  upsertCrm(row: CrmSendRow): Promise<void>
  getCrm(id: string): Promise<CrmSendRow | null>
  listCrm(limit: number): Promise<CrmSendRow[]>
  listCrmRetries(deviceId: string): Promise<CrmSendRow[]>
  audit(
    id: string,
    ts: number,
    actor: string,
    action: string,
    askId: string | null,
    detail: string,
    meta?: { requestId?: string; route?: string }
  ): Promise<void>
  listAudit(limit: number, opts?: AuditQueryOpts): Promise<AuditRow[]>
  insertEvent(row: EventRow): Promise<void>
  listEvents(limit: number): Promise<EventRow[]>
  listEvents(limit: number, opts: EventsQueryOpts): Promise<EventsPage>
  countEventsByKind(since: number, until: number): Promise<Record<string, number>>
  listVaultMeta(): Promise<VaultKeyMeta[]>
  listVaultRows(): Promise<VaultKeyRow[]>
  getVaultKey(id: string): Promise<VaultKeyRow | null>
  putVaultKey(row: VaultKeyRow): Promise<void>
  supersedeActiveVaultKeys(provider: string, exceptId: string, now: number): Promise<void>
  clearVaultSecret(id: string): Promise<void>
  putIssuedLicense(row: IssuedLicenseRow): Promise<void>
  getIssuedLicense(jti: string): Promise<IssuedLicenseRow | null>
  listIssuedLicenses(limit?: number): Promise<IssuedLicenseRow[]>
  updateIssuedLicense(jti: string, patch: Partial<IssuedLicenseRow>): Promise<boolean>
  revokeIssuedLicense(jti: string, now: number): Promise<boolean>

  // Sessions (operator/src/sessions.ts owns the pure 2-minute-gap math this wraps with I/O).
  touchSession(
    deviceId: string,
    ts: number,
    kind: PulseKind,
    geo: { country: string | null; city: string | null },
    seatMeta: { os: string | null; app_version: string | null }
  ): Promise<SessionState>
  listSessions(opts: SessionsQueryOpts): Promise<SessionsPage>
  getSession(id: string): Promise<SessionDetail | null>
  closeStaleSessions(now: number): Promise<number>

  // Groups and tiers (section 9c).
  listGroups(): Promise<GroupRow[]>
  getGroup(id: string): Promise<GroupRow | null>
  putGroup(row: GroupRow): Promise<void>
  deleteGroup(id: string): Promise<void>
  listGroupMembers(groupId: string): Promise<GroupMemberRow[]>
  putGroupMember(row: GroupMemberRow): Promise<void>
  deleteGroupMember(groupId: string, member: string): Promise<void>
  listTiers(): Promise<TierRow[]>
  putTier(row: TierRow): Promise<void>

  // Integrations hub (section 9c).
  listIntegrationsMeta(): Promise<IntegrationMeta[]>
  listIntegrationRows(): Promise<IntegrationRow[]>
  getIntegration(id: string): Promise<IntegrationRow | null>
  putIntegration(row: IntegrationRow): Promise<void>
  insertIntegrationGrant(row: IntegrationGrantRow): Promise<void>
  listIntegrationGrants(integrationId: string, limit: number): Promise<IntegrationGrantRow[]>
  bumpIntegrationUse(id: string, now: number): Promise<void>

  // Retention (operator/src/retention.ts calls this per table it prunes).
  pruneTable(table: 'events' | 'audit' | 'asks' | 'crm_sends' | 'rate_limits', before: number, cap: number): Promise<number>
}

const PULSE_TTL_MS = 8 * 24 * 60 * 60 * 1000
const SESSION_GAP_MS = 2 * 60 * 1000

/** Workers-safe base64url (no node:buffer): btoa/atob are in both the WebWorker and Node globals. */
function toBase64Url(raw: string): string {
  const bytes = new TextEncoder().encode(raw)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = (4 - (padded.length % 4)) % 4
  const bin = atob(padded + '='.repeat(pad))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function encodeCursor(ts: number, id: string): string {
  return toBase64Url(`${ts}:${id}`)
}

function decodeCursor(cursor: string | undefined): { ts: number; id: string } | null {
  if (!cursor) return null
  try {
    const raw = fromBase64Url(cursor)
    const i = raw.lastIndexOf(':')
    if (i < 0) return null
    const ts = Number(raw.slice(0, i))
    const id = raw.slice(i + 1)
    if (!Number.isFinite(ts) || !id) return null
    return { ts, id }
  } catch {
    return null
  }
}

function eventMatchesSeat(
  e: EventRow,
  seat: SeatRow | undefined,
  opts: Pick<EventsQueryOpts, 'os' | 'version' | 'country' | 'q'>
): boolean {
  if (opts.os && (seat?.os || '').toLowerCase() !== opts.os.toLowerCase()) return false
  if (opts.version && (seat?.app_version || '') !== opts.version) return false
  if (opts.country && (e.country || seat?.country || '').toUpperCase() !== opts.country.toUpperCase()) return false
  if (opts.q) {
    const q = opts.q.toLowerCase()
    const haystack = [e.kind, e.device_id, e.country, e.detail, seat?.hostname, seat?.sso_email, seat?.os, seat?.app_version]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    if (!haystack.includes(q)) return false
  }
  return true
}

function filterAndPageEvents(all: EventRow[], seatsById: Map<string, SeatRow>, opts: EventsQueryOpts): EventsPage {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 50
  const cursor = decodeCursor(opts.cursor)
  let rows = all.filter((e) => {
    if (opts.since != null && e.ts < opts.since) return false
    if (opts.until != null && e.ts > opts.until) return false
    if (opts.kinds && opts.kinds.length && !opts.kinds.includes(e.kind)) return false
    if (opts.deviceId && e.device_id !== opts.deviceId) return false
    const seat = e.device_id ? seatsById.get(e.device_id) : undefined
    return eventMatchesSeat(e, seat, opts)
  })
  rows = rows.sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id))
  if (cursor) {
    rows = rows.filter((e) => e.ts < cursor.ts || (e.ts === cursor.ts && e.id < cursor.id))
  }
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const nextCursor = page.length === limit && last ? encodeCursor(last.ts, last.id) : null
  return { rows: page, nextCursor }
}

export function memoryStore(): OperatorStore {
  const nonces = new Set<string>()
  const rates = new Map<string, { window_start: number; count: number }>()
  const seats = new Map<string, SeatRow>()
  const asks = new Map<string, AskRow>()
  const pulses: PulseRow[] = []
  const proposals = new Map<string, ProposalRow>()
  const packs = new Map<string, PackRow>()
  const crm = new Map<string, CrmSendRow>()
  const audits: AuditRow[] = []
  const events = new Map<string, EventRow>()
  const vault = new Map<string, VaultKeyRow>()
  const issued = new Map<string, IssuedLicenseRow>()
  const sessions = new Map<string, SessionState>()
  const groups = new Map<string, GroupRow>()
  const groupMembers = new Map<string, GroupMemberRow>()
  const tiers = new Map<string, TierRow>()
  const integrations = new Map<string, IntegrationRow>()
  const integrationGrants: IntegrationGrantRow[] = []
  let idSeq = 0
  const nextId = (): string => `mem-${++idSeq}`

  function openSessionFor(deviceId: string): SessionState | null {
    let best: SessionState | null = null
    for (const s of sessions.values()) {
      if (s.device_id !== deviceId) continue
      if (!best || s.started_at > best.started_at) best = s
    }
    return best
  }

  function listEventsOverload(limit: number): Promise<EventRow[]>
  function listEventsOverload(limit: number, opts: EventsQueryOpts): Promise<EventsPage>
  async function listEventsOverload(limit: number, opts?: EventsQueryOpts): Promise<EventRow[] | EventsPage> {
    if (opts) return filterAndPageEvents([...events.values()], seats, { ...opts, limit: opts.limit ?? limit })
    return [...events.values()].sort((a, b) => b.ts - a.ts).slice(0, limit)
  }

  return {
    async takeNonce(nonce) {
      if (nonces.has(nonce)) return true
      nonces.add(nonce)
      return false
    },
    async hitRate(deviceId, now, windowMs, max) {
      const cur = rates.get(deviceId)
      if (!cur || now - cur.window_start > windowMs) {
        rates.set(deviceId, { window_start: now, count: 1 })
        return false
      }
      cur.count++
      return cur.count > max
    },
    async upsertSeat(row) {
      const prev = seats.get(row.device_id)
      seats.set(row.device_id, {
        ...row,
        os: row.os && row.os !== 'unknown' ? row.os : prev?.os ?? row.os,
        app_version: row.app_version || prev?.app_version || '',
        first_seen: prev?.first_seen ?? row.first_seen,
        country: row.country ?? prev?.country ?? null,
        city: row.city ?? prev?.city ?? null,
        region: row.region ?? prev?.region ?? null,
        lat: row.lat ?? prev?.lat ?? null,
        lon: row.lon ?? prev?.lon ?? null,
        last_index_at: row.last_index_at ?? prev?.last_index_at ?? null,
        hostname: row.hostname ?? prev?.hostname ?? null,
        sso_email: row.sso_email ?? prev?.sso_email ?? null,
        license: row.license ?? prev?.license ?? null,
        license_jti: row.license_jti ?? prev?.license_jti ?? null,
        approval:
          prev?.approval ??
          row.approval ??
          ((prev?.license || '').toLowerCase() === 'approved' ? 'approved' : 'pending')
      })
    },
    async updateSeatApproval(deviceId, approval) {
      const prev = seats.get(deviceId)
      if (!prev) return false
      seats.set(deviceId, { ...prev, approval })
      return true
    },
    async getSeat(deviceId) {
      return seats.get(deviceId) ?? null
    },
    async insertAsk(row) {
      asks.set(row.id, row)
    },
    async updateAskRating(id, rating) {
      const row = asks.get(id)
      if (row) {
        row.rating = rating
        if (rating === 'down') row.outcome = 'thumbs-down'
      }
    },
    async listAsks(limit, since) {
      let rows = [...asks.values()]
      if (since != null) rows = rows.filter((a) => a.ts >= since)
      return rows.sort((a, b) => b.ts - a.ts).slice(0, limit)
    },
    async getAsk(id) {
      return asks.get(id) ?? null
    },
    async listSeats() {
      return [...seats.values()]
    },
    async insertPulse(row) {
      pulses.push(row)
      const cut = row.ts - PULSE_TTL_MS
      for (let i = pulses.length - 1; i >= 0; i--) {
        if (pulses[i].ts < cut) pulses.splice(i, 1)
      }
    },
    async listPulses(since) {
      return pulses.filter((p) => p.ts >= since)
    },
    async listProposals(limit) {
      const rows = [...proposals.values()].sort((a, b) => b.created_at - a.created_at)
      return limit != null ? rows.slice(0, limit) : rows
    },
    async getProposal(id) {
      return proposals.get(id) ?? null
    },
    async putProposal(row) {
      proposals.set(row.id, row)
    },
    async listPacks() {
      return [...packs.values()].map(({ body: _body, ...meta }) => meta)
    },
    async latestPacks() {
      const by = new Map<string, PackRow>()
      for (const p of packs.values()) {
        const cur = by.get(p.skill_id)
        if (!cur || p.pushed_at > cur.pushed_at) by.set(p.skill_id, p)
      }
      return [...by.values()].map(({ body: _body, ...meta }) => meta)
    },
    async putPack(row) {
      packs.set(row.id, row)
    },
    async upsertCrm(row) {
      crm.set(row.id, row)
    },
    async getCrm(id) {
      return crm.get(id) ?? null
    },
    async listCrm(limit) {
      return [...crm.values()].sort((a, b) => b.ts - a.ts).slice(0, limit)
    },
    async listCrmRetries(deviceId) {
      return [...crm.values()].filter(
        (r) =>
          r.device_id === deviceId &&
          r.retry_requested === 1 &&
          (r.status === 'pending' || r.status === 'failed' || r.status === 'expired')
      )
    },
    async audit(_id, ts, actor, action, askId, detail, meta) {
      audits.push({ ts, actor, action, ask_id: askId, detail, request_id: meta?.requestId ?? null, route: meta?.route ?? null })
    },
    async listAudit(limit, opts) {
      let rows = audits.slice().reverse()
      if (opts?.since != null) rows = rows.filter((a) => a.ts >= opts.since!)
      if (opts?.actor) rows = rows.filter((a) => a.actor === opts.actor)
      if (opts?.action) rows = rows.filter((a) => a.action === opts.action)
      return rows.slice(0, limit)
    },
    async insertEvent(row) {
      events.set(row.id, row)
    },
    listEvents: listEventsOverload,
    async countEventsByKind(since, until) {
      const out: Record<string, number> = {}
      for (const e of events.values()) {
        if (e.ts < since || e.ts > until) continue
        out[e.kind] = (out[e.kind] ?? 0) + 1
      }
      return out
    },
    async listVaultMeta() {
      return [...vault.values()]
        .sort((a, b) => b.created_at - a.created_at)
        .map(toVaultMeta)
    },
    async listVaultRows() {
      return [...vault.values()].sort((a, b) => b.created_at - a.created_at)
    },
    async getVaultKey(id) {
      return vault.get(id) ?? null
    },
    async putVaultKey(row) {
      vault.set(row.id, row)
    },
    async supersedeActiveVaultKeys(provider, exceptId, now) {
      for (const row of vault.values()) {
        if (row.provider !== provider || row.id === exceptId || row.status !== 'active') continue
        vault.set(row.id, { ...row, status: 'superseded', cipher: '', iv: '', rotated_at: now })
      }
    },
    async clearVaultSecret(id) {
      const row = vault.get(id)
      if (row) vault.set(id, { ...row, cipher: '', iv: '' })
    },
    async putIssuedLicense(row) {
      issued.set(row.jti, row)
    },
    async getIssuedLicense(jti) {
      return issued.get(jti) ?? null
    },
    async listIssuedLicenses(limit) {
      const rows = [...issued.values()].sort((a, b) => b.created_at - a.created_at)
      return limit != null ? rows.slice(0, limit) : rows
    },
    async updateIssuedLicense(jti, patch) {
      const row = issued.get(jti)
      if (!row) return false
      issued.set(jti, { ...row, ...patch })
      return true
    },
    async revokeIssuedLicense(jti, now) {
      const row = issued.get(jti)
      if (!row) return false
      issued.set(jti, { ...row, revoked: 1, activated_at: row.activated_at ?? now })
      return true
    },
    async touchSession(deviceId, ts, kind, geo, seatMeta) {
      const existing = openSessionFor(deviceId)
      const { session, closed } = applyPulse(
        existing,
        { deviceId, ts, kind, country: geo.country, city: geo.city, os: seatMeta.os, appVersion: seatMeta.app_version },
        nextId
      )
      if (closed) sessions.set(closed.id, closed)
      sessions.set(session.id, session)
      return session
    },
    async listSessions(opts) {
      let rows = [...sessions.values()]
      if (opts.since != null) rows = rows.filter((s) => s.started_at >= opts.since!)
      if (opts.until != null) rows = rows.filter((s) => s.started_at <= opts.until!)
      if (opts.deviceId) rows = rows.filter((s) => s.device_id === opts.deviceId)
      rows = rows.sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id))
      const cursor = decodeCursor(opts.cursor)
      if (cursor) rows = rows.filter((s) => s.started_at < cursor.ts || (s.started_at === cursor.ts && s.id < cursor.id))
      const limit = opts.limit > 0 ? opts.limit : 50
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      const nextCursor = page.length === limit && last ? encodeCursor(last.started_at, last.id) : null
      return { rows: page, nextCursor }
    },
    async getSession(id) {
      const session = sessions.get(id)
      if (!session) return null
      const end = session.ended_at ?? session.last_pulse_at
      const rows = pulses.filter((p) => p.device_id === session.device_id && p.ts >= session.started_at && p.ts <= end)
      return { session, pulses: rows }
    },
    async closeStaleSessions(now) {
      let n = 0
      for (const s of sessions.values()) {
        if (isSessionStale(s, now, SESSION_GAP_MS)) {
          sessions.set(s.id, { ...s, ended_at: s.last_pulse_at })
          n++
        }
      }
      return n
    },
    async listGroups() {
      return [...groups.values()].sort((a, b) => b.created_at - a.created_at)
    },
    async getGroup(id) {
      return groups.get(id) ?? null
    },
    async putGroup(row) {
      groups.set(row.id, row)
    },
    async deleteGroup(id) {
      groups.delete(id)
      for (const key of [...groupMembers.keys()]) {
        if (groupMembers.get(key)?.group_id === id) groupMembers.delete(key)
      }
    },
    async listGroupMembers(groupId) {
      return [...groupMembers.values()].filter((m) => m.group_id === groupId).sort((a, b) => a.added_at - b.added_at)
    },
    async putGroupMember(row) {
      groupMembers.set(`${row.group_id}\0${row.member}`, row)
    },
    async deleteGroupMember(groupId, member) {
      groupMembers.delete(`${groupId}\0${member}`)
    },
    async listTiers() {
      return [...tiers.values()].sort((a, b) => a.id.localeCompare(b.id))
    },
    async putTier(row) {
      tiers.set(row.id, row)
    },
    async listIntegrationsMeta() {
      return [...integrations.values()].sort((a, b) => b.created_at - a.created_at).map(toIntegrationMeta)
    },
    async listIntegrationRows() {
      return [...integrations.values()].sort((a, b) => b.created_at - a.created_at)
    },
    async getIntegration(id) {
      return integrations.get(id) ?? null
    },
    async putIntegration(row) {
      integrations.set(row.id, row)
    },
    async insertIntegrationGrant(row) {
      integrationGrants.push(row)
    },
    async listIntegrationGrants(integrationId, limit) {
      return integrationGrants
        .filter((g) => g.integration_id === integrationId)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
    },
    async bumpIntegrationUse(id, now) {
      const row = integrations.get(id)
      if (row) integrations.set(id, { ...row, uses: row.uses + 1, last_used_at: now })
    },
    async pruneTable(table, before, cap) {
      let n = 0
      if (table === 'events') {
        for (const [id, e] of [...events.entries()]) {
          if (n >= cap) break
          if (e.ts < before) {
            events.delete(id)
            n++
          }
        }
      } else if (table === 'audit') {
        for (let i = 0; i < audits.length && n < cap; ) {
          if (audits[i].ts < before) {
            audits.splice(i, 1)
            n++
          } else {
            i++
          }
        }
      } else if (table === 'asks') {
        for (const [id, a] of [...asks.entries()]) {
          if (n >= cap) break
          if (a.ts < before) {
            asks.delete(id)
            n++
          }
        }
      } else if (table === 'crm_sends') {
        for (const [id, r] of [...crm.entries()]) {
          if (n >= cap) break
          if (r.ts < before) {
            crm.delete(id)
            n++
          }
        }
      } else if (table === 'rate_limits') {
        for (const [id, r] of [...rates.entries()]) {
          if (n >= cap) break
          if (r.window_start < before) {
            rates.delete(id)
            n++
          }
        }
      }
      return n
    }
  }
}

export function toVaultMeta(row: VaultKeyRow): VaultKeyMeta {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    last4: row.last4,
    status: row.status,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
    revokedAt: row.revoked_at
  }
}
