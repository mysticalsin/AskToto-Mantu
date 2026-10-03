import { estimateCacheCost, estimateListPrice, formatUsdEstimate, type AskLogLine } from '../../../src/shared/operator'
import type { AskRow } from '../store'
import type { CostRow, TokenPoint } from '../dashboard'
import { askTokenTotal, HOUR } from './shared'

export function costForAsks(
  asks: {
    input_tokens?: number | null
    cache_read: number | null
    cache_write: number | null
    cache_uncached: number | null
    cache_status: string | null
    cache_ttl: string | null
    output_tokens: number | null
    model: string | null
    provider: string | null
  }[]
): string | null {
  let usd = 0
  let any = false
  for (const a of asks) {
    const est = estimateCacheCost(
      {
        cacheRead: a.cache_read ?? undefined,
        cacheWrite: a.cache_write ?? undefined,
        cacheUncached: a.cache_uncached ?? undefined,
        cacheStatus: (a.cache_status as AskLogLine['cacheStatus']) ?? undefined,
        cacheTtl: (a.cache_ttl as AskLogLine['cacheTtl']) ?? undefined,
        outputTokens: a.output_tokens ?? undefined
      },
      a.model || '',
      a.provider || undefined
    )
    const list = est ? null : estimateListPrice(a.model || '', a.input_tokens, a.output_tokens, a.cache_read)
    const hit = est ?? list
    if (hit) {
      any = true
      usd += hit.usd
    }
  }
  return any ? formatUsdEstimate(usd) : null
}

export function buildTokenPoints(asks: AskRow[], hourStarts: number[]): TokenPoint[] {
  return hourStarts.map((t) => {
    let read = 0
    let write = 0
    let uncached = 0
    for (const a of asks) {
      if (a.ts < t || a.ts >= t + HOUR) continue
      if (a.cache_read != null) read += a.cache_read
      if (a.cache_write != null) write += a.cache_write
      if (a.cache_uncached != null) uncached += a.cache_uncached
    }
    return { t, read, write, uncached }
  })
}

export function buildCostTable(weekAsks: AskRow[]): CostRow[] {
  const tableMap = new Map<string, CostRow & { usd: number; anyCost: boolean }>()
  for (const a of weekAsks) {
    const provider = a.provider || 'unknown'
    const mode = a.mode || 'unknown'
    const key = `${provider}\0${mode}`
    const cur = tableMap.get(key) ?? {
      provider,
      mode,
      asks: 0,
      read: null as number | null,
      write: null as number | null,
      uncached: null as number | null,
      estimate: null as string | null,
      usd: 0,
      anyCost: false
    }
    cur.asks++
    if (a.cache_read != null) cur.read = (cur.read ?? 0) + a.cache_read
    if (a.cache_write != null) cur.write = (cur.write ?? 0) + a.cache_write
    if (a.cache_uncached != null) cur.uncached = (cur.uncached ?? 0) + a.cache_uncached
    const est = estimateCacheCost(
      {
        cacheRead: a.cache_read ?? undefined,
        cacheWrite: a.cache_write ?? undefined,
        cacheUncached: a.cache_uncached ?? undefined,
        cacheStatus: (a.cache_status as AskLogLine['cacheStatus']) ?? undefined,
        cacheTtl: (a.cache_ttl as AskLogLine['cacheTtl']) ?? undefined,
        outputTokens: a.output_tokens ?? undefined
      },
      a.model || '',
      a.provider || undefined
    )
    if (est) {
      cur.anyCost = true
      cur.usd += est.usd
    }
    tableMap.set(key, cur)
  }
  return [...tableMap.values()].map((r) => ({
    provider: r.provider,
    mode: r.mode,
    asks: r.asks,
    read: r.read,
    write: r.write,
    uncached: r.uncached,
    estimate: r.anyCost ? formatUsdEstimate(r.usd) : null
  }))
}

export function portalPathSpend(asks: AskRow[], tag: 'portal-cf' | 'portal-direct'): string {
  const rows = asks.filter((a) => matchesPortalPath(a, tag))
  if (!rows.length) return 'not reported'
  let usd = 0
  let anyCost = false
  let tokens = 0
  let anyTok = false
  for (const a of rows) {
    const t = askTokenTotal(a)
    if (t != null) {
      anyTok = true
      tokens += t
    }
    const est = estimateListPrice(a.model || '', a.input_tokens, a.output_tokens, a.cache_read)
    if (!est) continue
    anyCost = true
    usd += est.usd
  }
  const parts: string[] = []
  if (anyTok) parts.push(`${tokens} tok`)
  if (anyCost) {
    parts.push(formatUsdEstimate(usd))
    parts.push('estimate, list price')
  }
  return parts.length ? parts.join(' · ') : 'not reported'
}

function matchesPortalPath(a: AskRow, tag: 'portal-cf' | 'portal-direct'): boolean {
  if (a.path_tag === tag) return true
  if (a.path_tag != null) return false
  if (tag === 'portal-cf') return (a.provider || '') === 'cloudflare'
  return (a.provider || '') === 'deepseek'
}
