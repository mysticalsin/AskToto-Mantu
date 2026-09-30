import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditFilesInOrder, countAuditEvents, writeAuditCounts } from './audit-counts.mjs'

const FROM = '2026-09-29T10:00:00.000Z'
const at = (minutes: number) => new Date(Date.parse(FROM) + minutes * 60_000).toISOString()
const line = (minutes: number, event: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ts: at(minutes), seq: 1, prev: 'x', event, ...extra })

let dirs: string[] = []
function profile(files: Record<string, string>): string {
  const userData = mkdtempSync(join(tmpdir(), 'audit-counts-'))
  dirs.push(userData)
  mkdirSync(join(userData, 'logs'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(userData, 'logs', name), text)
  return userData
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

describe('audit trail counts', () => {
  it('reads rotated generations oldest first by stamp, then the live file', () => {
    const userData = profile({ 'audit.log': '', 'audit-200.log': '', 'audit-1000.log': '', 'audit-20.log': '', 'other.log': '' })
    expect(auditFilesInOrder(userData).map((file) => file.split(/[\\/]/).at(-1))).toEqual([
      'audit-20.log',
      'audit-200.log',
      'audit-1000.log',
      'audit.log'
    ])
  })

  it('buckets allowlisted events across generations, tolerates a torn last line, and folds the rest into other', () => {
    const userData = profile({
      'audit-1.log': [
        line(1, 'scheduler.job', { kind: 'ingest', outcome: 'deferred' }),
        line(2, 'brain.ingest'),
        line(11, 'sidecar.spawn')
      ].join('\n') + '\n',
      'audit.log': [
        line(12, 'sidecar.exit'),
        line(12, 'scheduler.job', { kind: 'model-work', outcome: 'window-open' }),
        line(13, 'settings.change'),
        line(-5, 'brain.ingest'),
        '{"ts":"2026-09-29T10:14:00.000Z","seq":9,"ev'
      ].join('\n')
    })

    const result = countAuditEvents({ userData, from: FROM, bucketMinutes: 10 })

    expect(result.unparseableLines).toBe(1)
    expect(result.buckets).toEqual([
      {
        index: 0,
        startsAt: at(0),
        counts: { 'brain.ingest': 1, 'scheduler.job:deferred': 1 },
        other: 0
      },
      {
        index: 1,
        startsAt: at(10),
        counts: { 'scheduler.job:window-open': 1, 'sidecar.exit': 1, 'sidecar.spawn': 1 },
        other: 1
      }
    ])
  })

  it('never copies actor, detail fields, file names or text into the output', () => {
    const userData = profile({
      'audit.log':
        [
          line(1, 'brain.ingest', { actor: 'alice@example.test', file: 'Quarterly Board Notes.md', detail: 'secret text' }),
          line(1, 'scheduler.job', { outcome: 'Secret Outcome With Spaces', actor: 'bob', path: '/private/dir' }),
          line(1, 'mcp.push.queued', { title: 'confidential deal', actor: 'carol' }),
          line(1, 'user.custom', { text: 'meeting transcript words' })
        ].join('\n') + '\n'
    })
    const out = join(userData, 'out', 'counts.json')

    writeAuditCounts(out, { userData, from: FROM, bucketMinutes: 5 })
    const text = readFileSync(out, 'utf8')

    for (const leaked of ['alice', 'Quarterly', 'secret', 'Secret', 'bob', '/private', 'confidential', 'carol', 'transcript', 'user.custom']) {
      expect(text).not.toContain(leaked)
    }
    expect(JSON.parse(text).buckets[0]).toMatchObject({
      counts: { 'brain.ingest': 1, 'mcp.push.queued': 1, 'scheduler.job:unknown': 1 },
      other: 1
    })
  })

  it('returns no buckets when the profile has no audit trail', () => {
    const userData = mkdtempSync(join(tmpdir(), 'audit-counts-'))
    dirs.push(userData)
    expect(countAuditEvents({ userData, from: FROM, bucketMinutes: 10 }).buckets).toEqual([])
  })

  it('rejects a non-ISO --from and a non-positive bucket', () => {
    const userData = profile({})
    expect(() => countAuditEvents({ userData, from: 'yesterday', bucketMinutes: 10 })).toThrow('--from')
    expect(() => countAuditEvents({ userData, from: FROM, bucketMinutes: 0 })).toThrow('--bucket-minutes')
  })
})
