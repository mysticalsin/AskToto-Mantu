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

export const CRM_STATUS_LABEL: Record<CrmStatus, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  in_review: 'In review',
  submitted: 'Submitted',
  success: 'Success',
  failed: 'Failed',
  expired: 'Expired'
}

export function asCrmStatus(raw: unknown): CrmStatus | null {
  return typeof raw === 'string' && (CRM_STATUSES as readonly string[]).includes(raw) ? (raw as CrmStatus) : null
}

export interface CrmSendRow {
  id: string
  device_id: string
  ts: number
  status: CrmStatus
  title: string
  connector: string
  meeting_file: string | null
  last_error: string | null
  retry_requested: number
}
