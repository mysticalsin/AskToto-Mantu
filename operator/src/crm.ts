export const CRM_STATUSES = [
  'pending',
  'in_progress',
  'in_review',
  'submitted',
  'success',
  'failed',
  'expired'
] as const

export type CrmStatus = (typeof CRM_STATUSES)[number]

/** Dashboard option order from the StatusDemo paste. Filters, not a demo grid. */
export const CRM_FILTER_ORDER: readonly CrmStatus[] = [
  'pending',
  'failed',
  'success',
  'in_progress',
  'in_review',
  'expired',
  'submitted'
]

export const CRM_STATUS_LABEL: Record<CrmStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  in_review: 'In review',
  submitted: 'Submitted',
  success: 'Success',
  failed: 'Failed',
  expired: 'Expired'
}

const CRM_STATUS_ALIAS: Record<string, CrmStatus> = {
  pending: 'pending',
  failed: 'failed',
  success: 'success',
  expired: 'expired',
  submitted: 'submitted',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  in_review: 'in_review',
  'in-review': 'in_review',
  dead_letter: 'expired',
  'dead-letter': 'expired'
}

export function asCrmStatus(raw: unknown): CrmStatus | null {
  if (typeof raw !== 'string') return null
  return CRM_STATUS_ALIAS[raw.trim().toLowerCase()] ?? null
}

export interface CrmSendRow {
  id: string
  device_id: string
  ts: number
  status: CrmStatus
  title: string
  connector: string
  meeting_file: string | null
  meeting_hash: string | null
  last_error: string | null
  retry_requested: number
  attempt: number
  latency_ms: number
  remote_id: string | null
  remote_url: string | null
  action: string | null
}

export const CRM_CANONICAL_TITLE = 'CRM delivery'

export type CrmErrorClass = 'transient' | 'auth' | 'rate-limit' | 'usage-cap' | 'empty-response' | 'unknown'

export function classifyCrmError(raw: unknown): CrmErrorClass | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const value = raw.trim().toLowerCase()
  if (/rate.?limit|\b429\b|too many requests/.test(value)) return 'rate-limit'
  if (/usage.?cap|quota|credit|billing limit/.test(value)) return 'usage-cap'
  if (/empty.?response|no response|empty output/.test(value)) return 'empty-response'
  if (/\b401\b|\b403\b|auth|unauthori[sz]ed|forbidden|credential/.test(value)) return 'auth'
  if (/transient|timeout|timed out|network|econn|fetch failed|unavailable|\b5\d\d\b/.test(value)) return 'transient'
  return 'unknown'
}

function safeConnector(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown'
  const value = raw.trim()
  return value.length <= 32 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value) && !value.includes('://')
    ? value
    : 'unknown'
}

export function normalizeCrmRow(row: CrmSendRow): CrmSendRow {
  return {
    id: row.id,
    device_id: row.device_id,
    ts: row.ts,
    status: asCrmStatus(row.status) ?? 'pending',
    title: CRM_CANONICAL_TITLE,
    connector: safeConnector(row.connector),
    meeting_file: null,
    meeting_hash: null,
    last_error: classifyCrmError(row.last_error),
    retry_requested: row.retry_requested === 1 ? 1 : 0,
    attempt: Number.isFinite(row.attempt) ? Math.max(0, Math.floor(row.attempt)) : 0,
    latency_ms: Number.isFinite(row.latency_ms) ? Math.max(0, Math.floor(row.latency_ms)) : 0,
    remote_id: null,
    remote_url: null,
    action: null
  }
}
