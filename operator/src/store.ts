import { type CrmSendRow } from './crm'

export interface SeatRow {
  device_id: string
  seat_hash: string
  os: string
  app_version: string
  first_seen: number
  last_seen: number
  country: string | null
  city: string | null
  lat: number | null
  lon: number | null
  last_index_at: number | null
  hostname: string | null
  sso_email: string | null
  license: string | null
  /** Allowlisted Métis client id (metis-desktop, metis-ios, …). Null when unknown. */
  product: string | null
  /** Lifetime write-up-avoided estimate from the Métis client (minutes). */
  saved_minutes: number
  meetings_summarized: number
  conversation_minutes: number
}

export interface EventRow {
  id: string
  ts: number
  kind: string
  actor: string | null
  device_id: string | null
  country: string | null
  detail: string | null
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
}

export interface PulseRow {
  id: string
  device_id: string
  ts: number
  kind: 'heartbeat' | 'ask'
  country: string | null
  city: string | null
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


export interface LicenseRow {
  license_key: string
  company_name: string
  seat_cap: number
  created_at: number
  expires_at: number | null
  revoked: number
  contact_name: string
  contact_email: string
  notes: string
  created_by: string
}

export interface LicenseActivationRow {
  license_key: string
  machine_id: string
  machine_name: string
  activated_at: number
  last_seen_at: number
}

export interface OperatorStore {
  takeNonce(nonce: string, ts: number): Promise<boolean>
  hitRate(deviceId: string, now: number, windowMs: number, max: number): Promise<boolean>
  upsertSeat(row: SeatRow): Promise<void>
  insertAsk(row: AskRow): Promise<void>
  updateAskRating(id: string, rating: string): Promise<void>
  listAsks(limit: number): Promise<AskRow[]>
  getAsk(id: string): Promise<AskRow | null>
  listSeats(): Promise<SeatRow[]>
  insertPulse(row: PulseRow): Promise<void>
  listPulses(since: number): Promise<PulseRow[]>
  listProposals(): Promise<ProposalRow[]>
  getProposal(id: string): Promise<ProposalRow | null>
  putProposal(row: ProposalRow): Promise<void>
  listPacks(): Promise<PackRow[]>
  latestPacks(): Promise<PackRow[]>
  putPack(row: PackRow): Promise<void>
  upsertCrm(row: CrmSendRow): Promise<void>
  getCrm(id: string): Promise<CrmSendRow | null>
  listCrm(limit: number): Promise<CrmSendRow[]>
  listCrmRetries(deviceId: string): Promise<CrmSendRow[]>
  audit(id: string, ts: number, actor: string, action: string, askId: string | null, detail: string): Promise<void>
  listAudit(limit: number): Promise<{ ts: number; actor: string; action: string; ask_id: string | null; detail: string }[]>
  insertEvent(row: EventRow): Promise<void>
  listEvents(limit: number): Promise<EventRow[]>
  listVaultMeta(): Promise<VaultKeyMeta[]>
  listVaultRows(): Promise<VaultKeyRow[]>
  getVaultKey(id: string): Promise<VaultKeyRow | null>
  putVaultKey(row: VaultKeyRow): Promise<void>
  listLicenses(): Promise<LicenseRow[]>
  getLicense(licenseKey: string): Promise<LicenseRow | null>
  putLicense(row: LicenseRow): Promise<void>
  listLicenseActivations(licenseKey: string): Promise<LicenseActivationRow[]>
  putLicenseActivation(row: LicenseActivationRow): Promise<void>
}

const PULSE_TTL_MS = 8 * 24 * 60 * 60 * 1000

export function memoryStore(): OperatorStore {
  const nonces = new Set<string>()
  const rates = new Map<string, { window_start: number; count: number }>()
  const seats = new Map<string, SeatRow>()
  const asks = new Map<string, AskRow>()
  const pulses: PulseRow[] = []
  const proposals = new Map<string, ProposalRow>()
  const packs = new Map<string, PackRow>()
  const crm = new Map<string, CrmSendRow>()
  const audits: { id: string; ts: number; actor: string; action: string; ask_id: string | null; detail: string }[] = []
  const events = new Map<string, EventRow>()
  const vault = new Map<string, VaultKeyRow>()
  const licenses = new Map<string, LicenseRow>()
  const licenseActivations = new Map<string, LicenseActivationRow>()

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
        lat: row.lat ?? prev?.lat ?? null,
        lon: row.lon ?? prev?.lon ?? null,
        last_index_at: row.last_index_at ?? prev?.last_index_at ?? null,
        hostname: row.hostname ?? prev?.hostname ?? null,
        sso_email: row.sso_email ?? prev?.sso_email ?? null,
        license: row.license ?? prev?.license ?? null,
        product: row.product ?? prev?.product ?? null,
        saved_minutes:
          row.saved_minutes > 0 ? row.saved_minutes : (prev?.saved_minutes ?? row.saved_minutes ?? 0),
        meetings_summarized:
          row.meetings_summarized > 0
            ? row.meetings_summarized
            : (prev?.meetings_summarized ?? row.meetings_summarized ?? 0),
        conversation_minutes:
          row.conversation_minutes > 0
            ? row.conversation_minutes
            : (prev?.conversation_minutes ?? row.conversation_minutes ?? 0)
      })
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
    async listAsks(limit) {
      return [...asks.values()].sort((a, b) => b.ts - a.ts).slice(0, limit)
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
    async listProposals() {
      return [...proposals.values()].sort((a, b) => b.created_at - a.created_at)
    },
    async getProposal(id) {
      return proposals.get(id) ?? null
    },
    async putProposal(row) {
      proposals.set(row.id, row)
    },
    async listPacks() {
      return [...packs.values()]
    },
    async latestPacks() {
      const by = new Map<string, PackRow>()
      for (const p of packs.values()) {
        const cur = by.get(p.skill_id)
        if (!cur || p.pushed_at > cur.pushed_at) by.set(p.skill_id, p)
      }
      return [...by.values()]
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
    async audit(id, ts, actor, action, askId, detail) {
      audits.push({ id, ts, actor, action, ask_id: askId, detail })
    },
    async listAudit(limit) {
      return audits.slice(-limit).reverse()
    },
    async insertEvent(row) {
      events.set(row.id, row)
    },
    async listEvents(limit) {
      return [...events.values()].sort((a, b) => b.ts - a.ts).slice(0, limit)
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
    async listLicenses() {
      return [...licenses.values()].sort((a, b) => b.created_at - a.created_at)
    },
    async getLicense(licenseKey) {
      return licenses.get(licenseKey) ?? null
    },
    async putLicense(row) {
      licenses.set(row.license_key, row)
    },
    async listLicenseActivations(licenseKey) {
      return [...licenseActivations.values()]
        .filter((a) => a.license_key === licenseKey)
        .sort((a, b) => b.last_seen_at - a.last_seen_at)
    },
    async putLicenseActivation(row) {
      licenseActivations.set(`${row.license_key}::${row.machine_id}`, row)
    },
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
