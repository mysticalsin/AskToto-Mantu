import { createHash } from 'node:crypto'

export type OperatorCrmStatus =
  | 'pending'
  | 'in_progress'
  | 'in_review'
  | 'submitted'
  | 'success'
  | 'failed'
  | 'expired'

export interface OperatorCrmEvent {
  id: string
  status: OperatorCrmStatus
  title?: string
  connector?: string
  meetingHash?: string
  action?: string
  attempt?: number
  latencyMs?: number
  remoteId?: string
  remoteUrl?: string
  error?: string
  ts?: number
}

export function shouldIngestCrm(confidential: boolean): boolean {
  return confidential !== true
}

/** Hash of the meeting basename only. Never a filesystem path. */
export function meetingFileHash(meetingFile: string | undefined): string | undefined {
  if (!meetingFile) return undefined
  const base = meetingFile.replace(/^.*[/\\]/, '').trim()
  if (!base) return undefined
  return createHash('sha256').update(base).digest('hex').slice(0, 16)
}

export function extractMcpRemoteRef(result: unknown): { id?: string; url?: string; review?: boolean } {
  const found = { id: undefined as string | undefined, url: undefined as string | undefined, review: false }
  const walk = (node: unknown, depth: number): void => {
    if (depth > 5 || node == null) return
    if (typeof node === 'string') {
      if (!found.url && /^https:\/\//i.test(node) && node.length < 300) found.url = node
      return
    }
    if (typeof node !== 'object') return
    const rec = node as Record<string, unknown>
    for (const key of ['id', 'recordId', 'remoteId', 'crmId']) {
      if (!found.id && typeof rec[key] === 'string' && rec[key]) found.id = String(rec[key]).slice(0, 80)
    }
    for (const key of ['url', 'html_url', 'href', 'permalink']) {
      if (!found.url && typeof rec[key] === 'string' && /^https:\/\//i.test(rec[key])) {
        found.url = String(rec[key]).slice(0, 300)
      }
    }
    if (rec.review === true || rec.status === 'in_review' || rec.status === 'in-review') found.review = true
    for (const v of Object.values(rec)) walk(v, depth + 1)
  }
  walk(result, 0)
  return found
}

export function mapPushToCrmStatus(opts: {
  ok: boolean
  deadLetter?: boolean
  remoteId?: string
  review?: boolean
}): OperatorCrmStatus {
  if (opts.deadLetter) return 'expired'
  if (!opts.ok) return 'failed'
  if (opts.review) return 'in_review'
  if (opts.remoteId) return 'success'
  return 'submitted'
}

export function buildCrmIngestEvent(opts: {
  id: string
  ok: boolean
  deadLetter?: boolean
  title?: string
  connector: string
  meetingFile?: string
  action?: string
  attempt: number
  latencyMs: number
  result?: unknown
  error?: string
  ts?: number
}): OperatorCrmEvent {
  const remote = extractMcpRemoteRef(opts.result)
  return {
    id: opts.id,
    status: mapPushToCrmStatus({
      ok: opts.ok,
      deadLetter: opts.deadLetter,
      remoteId: remote.id,
      review: remote.review
    }),
    title: opts.title,
    connector: opts.connector,
    meetingHash: meetingFileHash(opts.meetingFile),
    action: opts.action,
    attempt: opts.attempt,
    latencyMs: opts.latencyMs,
    remoteId: remote.id,
    remoteUrl: remote.url,
    error: opts.ok ? undefined : opts.error,
    ts: opts.ts
  }
}
