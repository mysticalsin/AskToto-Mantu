import { describe, expect, it } from 'vitest'
import { redactDiagnosticsText } from './diagnostics-redaction'

describe('redactDiagnosticsText', () => {
  it('drops meeting-content fields of a JSON-lines audit trail and keeps the metadata', () => {
    const line = JSON.stringify({
      ts: '2026-10-23T10:00:00Z',
      event: 'ask.done',
      ms: 412,
      transcript: 'we agreed to fire Dana'
    })
    const out = redactDiagnosticsText(`${line}\n${line}`)
    expect(out.text).not.toContain('Dana')
    expect(out.text).toContain('"event":"ask.done"')
    expect(out.text).toContain('"ms":412')
    expect(out.counts['content-field']).toBe(2)
  })

  it('redacts content keys nested in arrays and objects, in a whole-file JSON document', () => {
    const doc = JSON.stringify({ report: { samples: [{ question: 'what is the budget?', ms: 3 }] } })
    const out = redactDiagnosticsText(doc)
    expect(out.text).not.toContain('budget')
    expect(out.text).toContain('"ms": 3')
    expect(out.counts['content-field']).toBe(1)
  })

  it('removes emails, tokens and home-directory account names from plain-text logs', () => {
    const token = 'sk-' + 'a'.repeat(32)
    const text = [
      'sync failed for jane.doe@example.com',
      `auth header Bearer ${'x'.repeat(30)}`,
      `key ${token}`,
      'at /Users/janedoe/Library/Application Support/Metis/x.js:1',
      'at C:\\Users\\JaneDoe\\AppData\\Roaming\\Metis\\x.js:1'
    ].join('\n')
    const out = redactDiagnosticsText(text)
    expect(out.text).not.toMatch(/jane\.doe|janedoe|JaneDoe|sk-a/i)
    expect(out.text).not.toContain('x'.repeat(30))
    expect(out.text).toContain('/Users/[user]/Library')
    expect(out.counts.email).toBe(1)
    expect(out.counts.secret).toBe(2)
    expect(out.counts['home-path']).toBe(2)
  })

  it('removes credentials and query strings from URLs but keeps the endpoint', () => {
    const out = redactDiagnosticsText('GET https://user:pw@api.example.com/v1/x?token=abc&id=9 failed')
    expect(out.text).not.toMatch(/user:pw|abc|id=9/)
    expect(out.text).toContain('api.example.com/v1/x')
    expect(out.counts['url-credential']).toBeGreaterThanOrEqual(1)
  })

  it('leaves clean diagnostics untouched and counts nothing', () => {
    const text = 'app.stall durationMs=812 version 2.12.0'
    const out = redactDiagnosticsText(text)
    expect(out.text).toBe(text)
    expect(out.total).toBe(0)
  })

  it('never reports the removed values in its counts', () => {
    const out = redactDiagnosticsText('mail a@b.io')
    expect(JSON.stringify(out.counts)).not.toContain('a@b.io')
  })
})
