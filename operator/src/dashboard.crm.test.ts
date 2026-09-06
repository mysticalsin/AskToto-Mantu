import { describe, expect, it } from 'vitest'
import { asCrmStatus, type CrmSendRow } from './crm'
import { crmFunnelByConnector, crmLandingKpis } from './dashboard'

function row(partial: Partial<CrmSendRow> & Pick<CrmSendRow, 'id' | 'status'>): CrmSendRow {
  return {
    device_id: 'dev',
    ts: 1_725_000_000_000,
    title: 'Acme',
    connector: 'bidstack',
    meeting_file: null,
    meeting_hash: 'abc',
    last_error: null,
    retry_requested: 0,
    attempt: 1,
    latency_ms: 10,
    remote_id: null,
    remote_url: null,
    action: 'log_note',
    ...partial
  }
}

describe('asCrmStatus aliases', () => {
  it('accepts hyphen forms and dead-letter as expired', () => {
    expect(asCrmStatus('in-progress')).toBe('in_progress')
    expect(asCrmStatus('in-review')).toBe('in_review')
    expect(asCrmStatus('dead-letter')).toBe('expired')
    expect(asCrmStatus('submitted')).toBe('submitted')
    expect(asCrmStatus('Submited')).toBeNull()
  })
})

describe('CRM landing KPIs and funnel', () => {
  it('counts landed today, fail rate, retries, and dead letters', () => {
    const now = Date.UTC(2026, 7, 31, 12)
    const rows = [
      row({ id: '1', status: 'success', ts: now, remote_id: 'deal-1' }),
      row({ id: '2', status: 'failed', ts: now }),
      row({ id: '3', status: 'expired', ts: now, retry_requested: 1 }),
      row({ id: '4', status: 'pending', ts: now })
    ]
    const k = crmLandingKpis(rows, now)
    expect(k.landedToday).toBe(1)
    expect(k.deadLetters).toBe(1)
    expect(k.retries).toBe(1)
    expect(k.failRatePct).toBe(66.7)
  })

  it('funnel is attempted to submitted to success vs failed by connector', () => {
    const rows = [
      row({ id: '1', status: 'in_progress', connector: 'clickup' }),
      row({ id: '2', status: 'submitted', connector: 'clickup' }),
      row({ id: '3', status: 'success', connector: 'clickup' }),
      row({ id: '4', status: 'failed', connector: 'clickup' }),
      row({ id: '5', status: 'success', connector: 'plane' })
    ]
    expect(crmFunnelByConnector(rows)).toEqual([
      { connector: 'clickup', attempted: 4, submitted: 2, success: 1, failed: 1 },
      { connector: 'plane', attempted: 1, submitted: 1, success: 1, failed: 0 }
    ])
  })
})
