import { describe, expect, it } from 'vitest'
import {
  buildCrmIngestEvent,
  extractMcpRemoteRef,
  mapPushToCrmStatus,
  meetingFileHash,
  shouldIngestCrm
} from './operator-crm'

describe('shouldIngestCrm', () => {
  it('never ingests a confidential action', () => {
    expect(shouldIngestCrm(true)).toBe(false)
    expect(shouldIngestCrm(false)).toBe(true)
  })
})

describe('meetingFileHash', () => {
  it('hashes the basename only, never a path', () => {
    const a = meetingFileHash('/Users/tony/Meetings/Acme.md')
    const b = meetingFileHash('C:\\\\Meetings\\\\Acme.md')
    const c = meetingFileHash('Acme.md')
    expect(a).toBe(c)
    expect(b).toBe(c)
    expect(a).toMatch(/^[a-f0-9]{16}$/)
    expect(a).not.toContain('Users')
    expect(a).not.toContain('Meetings')
  })
})

describe('mapPushToCrmStatus + remote id', () => {
  it('stores a remote id on success and maps review / dead-letter', () => {
    expect(mapPushToCrmStatus({ ok: true, remoteId: 'deal-99' })).toBe('success')
    expect(mapPushToCrmStatus({ ok: true })).toBe('submitted')
    expect(mapPushToCrmStatus({ ok: true, review: true })).toBe('in_review')
    expect(mapPushToCrmStatus({ ok: false })).toBe('failed')
    expect(mapPushToCrmStatus({ ok: false, deadLetter: true })).toBe('expired')
  })

  it('buildCrmIngestEvent keeps the remote id and never a meeting path', () => {
    const event = buildCrmIngestEvent({
      id: 'crm-1',
      ok: true,
      connector: 'bidstack',
      meetingFile: '/secret/path/Acme.md',
      action: 'log_note',
      attempt: 1,
      latencyMs: 42,
      result: { recordId: 'deal-99', url: 'https://crm.example/deal-99' }
    })
    expect(event.status).toBe('success')
    expect(event.remoteId).toBe('deal-99')
    expect(event.remoteUrl).toBe('https://crm.example/deal-99')
    expect(event.meetingHash).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.stringify(event)).not.toContain('/secret/path')
  })

  it('extractMcpRemoteRef walks nested MCP payloads', () => {
    expect(extractMcpRemoteRef({ content: [{ type: 'text', text: 'ok' }], id: 'cu-1' })).toEqual({
      id: 'cu-1',
      url: undefined,
      review: false
    })
  })

  it('carries credentialSource through when the caller supplies one, omits it otherwise', () => {
    const withSource = buildCrmIngestEvent({
      id: 'crm-2',
      ok: true,
      connector: 'plane',
      action: 'create_issue',
      attempt: 1,
      latencyMs: 10,
      credentialSource: 'operator'
    })
    expect(withSource.credentialSource).toBe('operator')

    const withoutSource = buildCrmIngestEvent({
      id: 'crm-3',
      ok: true,
      connector: 'plane',
      action: 'create_issue',
      attempt: 1,
      latencyMs: 10
    })
    expect(withoutSource.credentialSource).toBeUndefined()
  })
})
