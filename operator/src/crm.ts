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

export function normalizeCrmRow(row: CrmSendRow): CrmSendRow {
  return {
    id: row.id,
    device_id: row.device_id,
    ts: row.ts,
    status: asCrmStatus(row.status) ?? 'pending',
    title: row.title,
    connector: row.connector,
    meeting_file: row.meeting_file ?? null,
    meeting_hash: row.meeting_hash ?? null,
    last_error: row.last_error ?? null,
    retry_requested: row.retry_requested === 1 ? 1 : 0,
    attempt: Number.isFinite(row.attempt) ? Math.max(0, Math.floor(row.attempt)) : 0,
    latency_ms: Number.isFinite(row.latency_ms) ? Math.max(0, Math.floor(row.latency_ms)) : 0,
    remote_id: row.remote_id ?? null,
    remote_url: row.remote_url ?? null,
    action: row.action ?? null
  }
}
