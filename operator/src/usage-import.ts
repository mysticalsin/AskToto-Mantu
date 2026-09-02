/**
 * Import DeepSeek platform usage CSVs (amount + cost) into Operator asks/pulses/vault.
 * Source: usage_data_YYYY-MM-DD_YYYY-MM-DD.zip → amount-*.csv + cost-*.csv.
 * Does not invent seats/geo — only provider usage already billed on the Amaris key.
 */
import type { AskRow, OperatorStore, PulseRow, SeatRow, VaultKeyRow } from './store'

export const USAGE_DEVICE_ID = 'usage-deepseek-amaris'
export const USAGE_VAULT_ID = 'vault-deepseek-amaris-usage'
export const USAGE_PREVIEW = 'DeepSeek usage import'
export const USAGE_MODE = 'usage-import'

export interface UsageDayModel {
  day: string
  startIso: string
  model: string
  apiKeyName: string
  apiKeyLast4: string
  requestCount: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  /** Billed USD for this day+model from the cost CSV, when present. */
  costUsd: number
}

export interface UsageImportPlan {
  from: string
  to: string
  days: UsageDayModel[]
  asks: AskRow[]
  pulses: PulseRow[]
  seat: SeatRow
  vault: VaultKeyRow
  totals: {
    requests: number
    tokens: number
    costUsd: number
  }
}

function stripBom(s: string): string {
  return s.replace(/^\uFEFF/, '')
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = stripBom(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n')
  if (lines.length < 2) return []
  const headers = splitCsvLine(lines[0]).map((h) => h.trim())
  const rows: Record<string, string>[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue
    const cells = splitCsvLine(line)
    const row: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) row[headers[i]] = (cells[i] ?? '').trim()
    rows.push(row)
  }
  return rows
}

/** Minimal CSV splitter that respects quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out
}

function dayKey(iso: string): string {
  return iso.slice(0, 10)
}

function last4FromMaskedKey(masked: string): string {
  const cleaned = masked.replace(/\*/g, '')
  const m = /([A-Za-z0-9]{2,8})\s*$/.exec(cleaned)
  if (m) return m[1].slice(-4)
  const tail = masked.replace(/[^A-Za-z0-9]/g, '').slice(-4)
  return tail || '----'
}

function distribute(total: number, n: number): number[] {
  if (n <= 0) return []
  if (total <= 0) return Array.from({ length: n }, () => 0)
  const base = Math.floor(total / n)
  const rem = total - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0))
}

/** Split USD across n asks without losing precision to float noise. */
function distributeUsd(usd: number, n: number): number[] {
  if (n <= 0) return []
  if (!(usd > 0)) return Array.from({ length: n }, () => 0)
  const units = Math.round(usd * 1e10)
  const base = Math.floor(units / n)
  const rem = units - base * n
  return Array.from({ length: n }, (_, i) => (base + (i < rem ? 1 : 0)) / 1e10)
}

export function parseUsageCsvs(amountCsv: string, costCsv: string): UsageDayModel[] {
  const amountRows = parseCsv(amountCsv)
  const costRows = parseCsv(costCsv)
  const byKey = new Map<string, UsageDayModel>()

  for (const r of amountRows) {
    const startIso = r.start_time_iso || ''
    const model = r.model || 'unknown'
    const day = dayKey(startIso)
    const key = `${day}\0${model}`
    const cur =
      byKey.get(key) ??
      ({
        day,
        startIso,
        model,
        apiKeyName: r.api_key_name || 'Amaris',
        apiKeyLast4: last4FromMaskedKey(r.api_key || ''),
        requestCount: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        outputTokens: 0,
        costUsd: 0
      } satisfies UsageDayModel)
    const amount = Number(r.amount || 0)
    const type = r.type || ''
    if (type === 'request_count') cur.requestCount += amount
    else if (type === 'input_cache_hit_tokens') cur.cacheHitTokens += amount
    else if (type === 'input_cache_miss_tokens') cur.cacheMissTokens += amount
    else if (type === 'output_tokens') cur.outputTokens += amount
    if (r.api_key_name) cur.apiKeyName = r.api_key_name
    if (r.api_key) cur.apiKeyLast4 = last4FromMaskedKey(r.api_key)
    if (!cur.startIso) cur.startIso = startIso
    byKey.set(key, cur)
  }

  for (const r of costRows) {
    const day = dayKey(r.start_time_iso || '')
    const model = r.model || 'unknown'
    const key = `${day}\0${model}`
    const cur = byKey.get(key)
    if (!cur) continue
    cur.costUsd += Number(r.cost || 0)
  }

  return [...byKey.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model))
}

export function planUsageImport(amountCsv: string, costCsv: string, importedAt = Date.now()): UsageImportPlan {
  const days = parseUsageCsvs(amountCsv, costCsv)
  const asks: AskRow[] = []
  const pulses: PulseRow[] = []
  let firstTs = importedAt
  let lastTs = 0

  for (const d of days) {
    const n = Math.max(1, Math.round(d.requestCount) || 1)
    const hits = distribute(Math.round(d.cacheHitTokens), n)
    const misses = distribute(Math.round(d.cacheMissTokens), n)
    const outs = distribute(Math.round(d.outputTokens), n)
    const costs = distributeUsd(d.costUsd, n)
    const startMs = Date.parse(d.startIso) || Date.parse(`${d.day}T12:00:00.000Z`)
    const span = Math.max(60_000, 20 * 60 * 60 * 1000)

    for (let i = 0; i < n; i++) {
      const ts = startMs + Math.floor(((i + 0.5) / n) * span)
      firstTs = Math.min(firstTs, ts)
      lastTs = Math.max(lastTs, ts)
      const cacheRead = hits[i] ?? 0
      const cacheUncached = misses[i] ?? 0
      const output = outs[i] ?? 0
      const input = cacheRead + cacheUncached
      const cost = costs[i] ?? 0
      const id = `usage-${d.day}-${d.model}-${i + 1}`
      asks.push({
        id,
        device_id: USAGE_DEVICE_ID,
        ts,
        mode: USAGE_MODE,
        skill_id: null,
        skill_version: null,
        provider: 'deepseek',
        model: d.model,
        ttft_ms: null,
        total_ms: null,
        input_tokens: input || null,
        output_tokens: output || null,
        cache_read: cacheRead || null,
        cache_write: null,
        cache_uncached: cacheUncached || null,
        cache_status: cacheRead > 0 ? 'read' : cacheUncached > 0 ? 'miss' : 'reported',
        cache_ttl: null,
        outcome: cost > 0 ? `billed_usd:${cost.toFixed(10)}` : null,
        rating: null,
        prompt_cipher: null,
        prompt_iv: null,
        preview: USAGE_PREVIEW
      })
      pulses.push({
        id: `pulse-${id}`,
        device_id: USAGE_DEVICE_ID,
        ts,
        kind: 'ask',
        country: null,
        city: null
      })
    }
  }

  if (!lastTs) lastTs = importedAt
  if (!Number.isFinite(firstTs)) firstTs = lastTs

  const seat: SeatRow = {
    device_id: USAGE_DEVICE_ID,
    seat_hash: 'usage-deepseek-amaris',
    os: 'unknown',
    app_version: 'usage-import',
    first_seen: firstTs,
    last_seen: lastTs,
    country: null,
    city: null,
    lat: null,
    lon: null,
    last_index_at: null,
    hostname: null,
    sso_email: null,
    license: null
  }

  const last4 = days.find((d) => d.apiKeyLast4 && d.apiKeyLast4 !== '----')?.apiKeyLast4 || 'cfc3'
  const label = days.find((d) => d.apiKeyName)?.apiKeyName || 'Amaris'
  const vault: VaultKeyRow = {
    id: USAGE_VAULT_ID,
    provider: 'deepseek',
    label,
    last4,
    // Placeholder ciphertext — unlocks Overview token tiles; cannot decrypt provider calls.
    cipher: 'usage-import-placeholder',
    iv: 'usage-import',
    status: 'active',
    created_at: importedAt,
    created_by: 'usage-import',
    rotated_at: null,
    revoked_at: null
  }

  const requests = asks.length
  const tokens = asks.reduce((n, a) => n + (a.input_tokens ?? 0) + (a.output_tokens ?? 0), 0)
  const costUsd = days.reduce((n, d) => n + d.costUsd, 0)
  const from = days[0]?.day ?? ''
  const to = days[days.length - 1]?.day ?? ''

  return { from, to, days, asks, pulses, seat, vault, totals: { requests, tokens, costUsd } }
}

export async function applyUsageImport(
  store: OperatorStore,
  plan: UsageImportPlan,
  actor = 'usage-import'
): Promise<{ asks: number; pulses: number; from: string; to: string; tokens: number; costUsd: number }> {
  await store.upsertSeat(plan.seat)
  await store.putVaultKey(plan.vault)
  for (const ask of plan.asks) await store.insertAsk(ask)
  for (const pulse of plan.pulses) await store.insertPulse(pulse)
  await store.audit(
    `audit-usage-${plan.from}-${plan.to}`,
    Date.now(),
    actor,
    'usage-import',
    null,
    `DeepSeek ${plan.from}→${plan.to} · ${plan.totals.requests} asks · ${plan.totals.tokens} tokens · $${plan.totals.costUsd.toFixed(4)}`
  )
  return {
    asks: plan.asks.length,
    pulses: plan.pulses.length,
    from: plan.from,
    to: plan.to,
    tokens: plan.totals.tokens,
    costUsd: plan.totals.costUsd
  }
}

export function billedUsdFromOutcome(outcome: string | null | undefined): number | null {
  if (!outcome) return null
  const m = /^billed_usd:([0-9]+(?:\.[0-9]+)?)$/.exec(outcome.trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

export function usageWindowFromAsks(
  asks: {
    mode: string | null
    preview: string | null
    ts: number
    input_tokens?: number | null
    output_tokens?: number | null
    outcome?: string | null
  }[]
): { from: string; to: string; count: number; tokens: number; costUsd: number } | null {
  const rows = asks.filter((a) => a.mode === USAGE_MODE || a.preview === USAGE_PREVIEW)
  if (!rows.length) return null
  const times = rows.map((a) => a.ts).sort((a, b) => a - b)
  const fmt = (ts: number): string => new Date(ts).toISOString().slice(0, 10)
  let tokens = 0
  let costUsd = 0
  for (const a of rows) {
    tokens += (a.input_tokens ?? 0) + (a.output_tokens ?? 0)
    const billed = billedUsdFromOutcome(a.outcome)
    if (billed != null) costUsd += billed
  }
  return {
    from: fmt(times[0]),
    to: fmt(times[times.length - 1]),
    count: rows.length,
    tokens,
    costUsd
  }
}
