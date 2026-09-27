import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { copyDiagnosticsSummary, summarizeAuditTrail } from './diagnostics-summary'

const identity = { version: '2.0.15', platform: 'darwin', arch: 'arm64' }
const generatedAt = new Date('2026-01-01T00:00:00.000Z')

function line(event: string, detail: Record<string, unknown> = {}, ts = '2026-01-01T00:00:00.000Z'): string {
  return JSON.stringify({ ts, event, ...detail })
}

describe('diagnostics summary', () => {
  it('aggregates boots, stalls, crashes, reveals and event counts', () => {
    const summary = summarizeAuditTrail([
      line('app.started', { prevShutdown: 'clean' }, '2026-01-01T00:00:01.000Z'),
      line('app.started', { prevShutdown: 'unclean' }, '2026-01-01T00:00:02.000Z'),
      line('app.started', { prevShutdown: 'unknown' }, '2026-01-01T00:00:03.000Z'),
      line('app.stall', { durationMs: 1999 }),
      line('app.stall', { durationMs: 2000 }),
      line('app.stall', { durationMs: 4999 }),
      line('app.stall', { durationMs: 5000 }),
      line('app.stall', { durationMs: 29999 }),
      line('app.stall', { durationMs: 30000 }),
      line('app.crash', { fatal: true }),
      line('app.crash', { fatal: false }),
      line('app.crash', {}),
      line('reveal', { outcome: 'created' }),
      line('reveal', { outcome: 'shown' }),
      line('reveal', { outcome: 'already-visible' }),
      line('reveal', { outcome: 'failed' }),
      line('brain.index.quarantined', { cause: 'invalid' })
    ], identity, generatedAt)

    expect(summary).toMatchObject({
      kind: 'metis-diagnostics-summary',
      schema: 1,
      generatedAt: generatedAt.toISOString(),
      app: identity,
      window: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:03.000Z', records: 17 },
      boots: { started: 3, prevShutdown: { clean: 1, unclean: 1, unknown: 1 } },
      stalls: { under2s: 1, '2to5s': 2, '5to30s': 2, '30sPlus': 1 },
      crashes: { fatal: 1, nonFatal: 1, unclassified: 1 },
      reveals: { created: 1, shown: 1, 'already-visible': 1, failed: 1 }
    })
    expect(summary.events['brain.index.quarantined']).toBe(1)
  })

  it('skips malformed lines and bad event names', () => {
    const summary = summarizeAuditTrail([
      '{',
      line('Bad.Event'),
      line('app.started'),
      line('app.' + 'x'.repeat(70))
    ], identity, generatedAt)

    expect(summary.window.records).toBe(1)
    expect(summary.events).toEqual({ 'app.started': 1 })
  })

  it('counts event names that collide with Object.prototype keys', () => {
    const summary = summarizeAuditTrail([line('constructor')], identity, generatedAt)

    expect(summary.events['constructor']).toBe(1)
    expect(Object.prototype.hasOwnProperty.call(summary.events, 'constructor')).toBe(true)
    expect(Object.keys(summary.events)).toEqual(['constructor'])
  })

  it('round-trips an empty event list to an empty JSON object', () => {
    const zeroSummaryJson = JSON.parse(JSON.stringify(summarizeAuditTrail([], identity, generatedAt)))
    expect(zeroSummaryJson.events).toEqual({})
  })

  it('copies no actor, title, path, request id, boot id or message content into JSON', () => {
    const summary = summarizeAuditTrail([
      line('app.crash', {
        actor: 'jane.doe@acme.example',
        message: 'Board budget failed at /var/tmp/metis/Meetings/Board.md',
        bootId: '123e4567-e89b-12d3-a456-426614174000',
        requestId: '123e4567-e89b-12d3-a456-426614174001'
      }),
      line('brain.index.quarantined', { title: 'Board budget', account: 'Acme' })
    ], identity, generatedAt)
    const json = JSON.stringify(summary)

    for (const marker of ['jane', '@', 'Board', 'budget', 'Meetings', '/var/tmp', '123e4567']) {
      expect(json).not.toContain(marker)
    }
  })

  it('copyDiagnosticsSummary writes summary JSON from the audit trail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-summary-'))
    try {
      const auditTrailPath = join(root, 'audit.log')
      writeFileSync(auditTrailPath, `${line('app.started', { prevShutdown: 'clean' })}\n`, 'utf8')
      let copied = ''

      await copyDiagnosticsSummary({
        auditTrailPath,
        identity,
        now: () => generatedAt,
        writeText: (text) => {
          copied = text
        }
      })

      expect(JSON.parse(copied)).toMatchObject({ boots: { started: 1 } })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('copyDiagnosticsSummary writes a zero summary when the trail is missing', async () => {
    let copied = ''

    await copyDiagnosticsSummary({
      auditTrailPath: join(tmpdir(), 'does-not-exist', 'audit.log'),
      identity,
      now: () => generatedAt,
      writeText: (text) => {
        copied = text
      }
    })

    expect(JSON.parse(copied)).toMatchObject({
      window: { from: null, to: null, records: 0 },
      boots: { started: 0 }
    })
  })

  it('copyDiagnosticsSummary resolves when writeText throws', async () => {
    await expect(copyDiagnosticsSummary({
      auditTrailPath: join(tmpdir(), 'does-not-exist', 'audit.log'),
      identity,
      now: () => generatedAt,
      writeText: () => {
        throw new Error('clipboard unavailable')
      }
    })).resolves.toBeUndefined()
  })
})
