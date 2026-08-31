export interface SeatRow {
  device_id: string
  seat_hash: string
  os: string
  app_version: string
  first_seen: number
  last_seen: number
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

export interface OperatorStore {
  takeNonce(nonce: string, ts: number): Promise<boolean>
  hitRate(deviceId: string, now: number, windowMs: number, max: number): Promise<boolean>
  upsertSeat(row: SeatRow): Promise<void>
  insertAsk(row: AskRow): Promise<void>
  updateAskRating(id: string, rating: string): Promise<void>
  listAsks(limit: number): Promise<AskRow[]>
  getAsk(id: string): Promise<AskRow | null>
  listSeats(): Promise<SeatRow[]>
  listProposals(): Promise<ProposalRow[]>
  getProposal(id: string): Promise<ProposalRow | null>
  putProposal(row: ProposalRow): Promise<void>
  listPacks(): Promise<PackRow[]>
  latestPacks(): Promise<PackRow[]>
  putPack(row: PackRow): Promise<void>
  audit(id: string, ts: number, actor: string, action: string, askId: string | null, detail: string): Promise<void>
  listAudit(limit: number): Promise<{ ts: number; actor: string; action: string; ask_id: string | null; detail: string }[]>
}

export function memoryStore(): OperatorStore {
  const nonces = new Set<string>()
  const rates = new Map<string, { window_start: number; count: number }>()
  const seats = new Map<string, SeatRow>()
  const asks = new Map<string, AskRow>()
  const proposals = new Map<string, ProposalRow>()
  const packs = new Map<string, PackRow>()
  const audits: { id: string; ts: number; actor: string; action: string; ask_id: string | null; detail: string }[] = []

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
        first_seen: prev?.first_seen ?? row.first_seen
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
    async audit(id, ts, actor, action, askId, detail) {
      audits.push({ id, ts, actor, action, ask_id: askId, detail })
    },
    async listAudit(limit) {
      return audits.slice(-limit).reverse()
    }
  }
}
