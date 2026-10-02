import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  copyDiagnosticsSummary,
  REVEAL_IS_NO_OP,
  summarizeAuditGenerations,
  summarizeAuditTrail
} from './diagnostics-summary'
import { REVEAL_OUTCOMES } from './projection'

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
      schema: 2,
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

async function withTrail(files: Record<string, string>, fn: (auditTrailPath: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'metis-summary-'))
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text, 'utf8')
    await fn(join(root, 'audit.log'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const started = (version: string, prevShutdown: string, ts: string): string =>
  line('app.started', { version, prevShutdown, bootId: '123e4567-e89b-12d3-a456-426614174000' }, ts)

describe('diagnostics summary schema 2', () => {
  it('reads rotated generations oldest first, then the live file, and skips a torn last line', async () => {
    await withTrail({
      // 999 sorts after 1000 as text: only a numeric stamp order puts this generation first.
      'audit-999.log': [
        started('2.0.15', 'clean', '2026-01-01T08:00:00.000Z'),
        line('app.stall', { durationMs: 6000 }, '2026-01-01T09:00:00.000Z')
      ].join('\n') + '\n',
      'audit-1000.log': [
        line('app.stall', { durationMs: 7000 }, '2026-01-01T10:00:00.000Z'),
        line('reveal', { outcome: 'failed' }, '2026-01-02T09:00:00.000Z')
      ].join('\n') + '\n',
      'audit.log': [
        started('2.0.15', 'unclean', '2026-01-02T10:00:00.000Z'),
        line('brain.index.quarantined', { kept: 1, cap: 3 }, '2026-01-02T11:00:00.000Z'),
        '{"ts":"2026-01-02T12:00:00.000Z","event":"app.st'
      ].join('\n'),
      'main.log': 'not an audit generation\n'
    }, async (auditTrailPath) => {
      const summary = await summarizeAuditGenerations(auditTrailPath, identity, generatedAt)

      expect(summary.window).toEqual({
        from: '2026-01-01T08:00:00.000Z',
        to: '2026-01-02T11:00:00.000Z',
        records: 6,
        generations: 3,
        truncated: false
      })
      expect(summary.scope).toMatchObject({
        version: '2.0.15',
        from: '2026-01-01T08:00:00.000Z',
        to: '2026-01-02T11:00:00.000Z',
        records: 6,
        boots: { started: 2, prevShutdown: { clean: 1, unclean: 1, unknown: 0 } },
        soak: {
          stallsOver5s: 2,
          uncleanShutdowns: 1,
          orphanReaps: { registry: 0, 'legacy-orphan': 0, afterUncleanExit: 0 },
          revealNoOps: 1,
          brainIndexQuarantined: 1
        }
      })
      expect(summary.scope.days['2026-01-01']).toMatchObject({ records: 3, boots: 1, stallsOver5s: 2 })
      expect(summary.scope.days['2026-01-02']).toMatchObject({
        records: 3,
        boots: 1,
        uncleanShutdowns: 1,
        revealNoOps: 1,
        brainIndexQuarantined: 1
      })
    })
  })

  it('starts a new scope at the first app.started of the running version after a version change', () => {
    const summary = summarizeAuditTrail([
      started('2.0.14', 'clean', '2026-01-01T00:00:00.000Z'),
      line('app.stall', { durationMs: 9000 }, '2026-01-01T01:00:00.000Z'),
      started('2.0.15', 'clean', '2026-01-02T00:00:00.000Z'),
      line('app.stall', { durationMs: 6000 }, '2026-01-02T01:00:00.000Z'),
      started('2.0.15', 'unclean', '2026-01-03T00:00:00.000Z'),
      line('app.stall', { durationMs: 1000 }, '2026-01-03T01:00:00.000Z')
    ], identity, generatedAt)

    expect(summary.boots.started).toBe(3)
    expect(summary.stalls['5to30s']).toBe(2)
    expect(summary.scope).toMatchObject({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T01:00:00.000Z',
      records: 4,
      boots: { started: 2 },
      stalls: { under2s: 1, '2to5s': 0, '5to30s': 1, '30sPlus': 0 },
      soak: { stallsOver5s: 1, uncleanShutdowns: 1 }
    })
    expect(Object.keys(summary.scope.days)).toEqual(['2026-01-02', '2026-01-03'])
  })

  it('restarts the scope when the trail leaves the running version and comes back', () => {
    const summary = summarizeAuditTrail([
      started('2.0.15', 'clean', '2026-01-01T00:00:00.000Z'),
      line('app.stall', { durationMs: 6000 }, '2026-01-01T01:00:00.000Z'),
      started('2.0.14', 'clean', '2026-01-02T00:00:00.000Z'),
      line('app.stall', { durationMs: 6000 }, '2026-01-02T01:00:00.000Z'),
      started('2.0.15', 'clean', '2026-01-03T00:00:00.000Z'),
      line('app.stall', { durationMs: 1000 }, '2026-01-03T01:00:00.000Z')
    ], identity, generatedAt)

    expect(summary.scope).toMatchObject({ from: '2026-01-03T00:00:00.000Z', records: 2, soak: { stallsOver5s: 0 } })
  })

  it('has an empty scope when the running version never started in the trail', () => {
    const summary = summarizeAuditTrail([
      started('2.0.14', 'unclean', '2026-01-01T00:00:00.000Z'),
      line('app.stall', { durationMs: 6000 }, '2026-01-01T01:00:00.000Z')
    ], identity, generatedAt)

    expect(summary.window.records).toBe(2)
    expect(summary.scope).toMatchObject({
      from: null,
      to: null,
      records: 0,
      daySpan: 0,
      idleDays: 0,
      days: {},
      soak: { stallsOver5s: 0, uncleanShutdowns: 0 }
    })
  })

  it('buckets activity per UTC day and reports a day with no records as idle', () => {
    const summary = summarizeAuditTrail([
      started('2.0.15', 'clean', '2026-01-01T23:59:59.000Z'),
      line('app.stall', { durationMs: 5000 }, '2026-01-01T23:59:59.500Z'),
      line('reveal', { outcome: 'already-visible' }, '2026-01-03T00:00:00.000Z'),
      line('app.stall', { durationMs: 31000 }, '2026-01-03T12:00:00.000Z')
    ], identity, generatedAt)

    expect(Object.keys(summary.scope.days)).toEqual(['2026-01-01', '2026-01-03'])
    expect(summary.scope.daySpan).toBe(3)
    expect(summary.scope.idleDays).toBe(1)
    // Exactly 5 s is not over 5 s.
    expect(summary.scope.days['2026-01-01']).toEqual({
      records: 2,
      boots: 1,
      uncleanShutdowns: 0,
      stallsOver5s: 0,
      orphanReaps: 0,
      revealNoOps: 0,
      brainIndexQuarantined: 0
    })
    expect(summary.scope.days['2026-01-03']).toEqual({
      records: 2,
      boots: 0,
      uncleanShutdowns: 0,
      stallsOver5s: 1,
      orphanReaps: 0,
      revealNoOps: 1,
      brainIndexQuarantined: 0
    })
  })

  it('attributes reaps written before a boot to that boot, split by reason and by an unclean prior exit', () => {
    const summary = summarizeAuditTrail([
      line('sidecar.reaped', { name: 'llama-server', pid: 11, reason: 'registry' }, '2025-12-31T00:00:00.000Z'),
      started('2.0.14', 'unclean', '2025-12-31T00:00:01.000Z'),
      line('sidecar.reaped', { name: 'fm-serve', pid: 12, reason: 'registry' }, '2026-01-01T00:00:00.000Z'),
      started('2.0.15', 'clean', '2026-01-01T00:00:01.000Z'),
      line('sidecar.reaped', { name: 'llama-server', pid: 13, reason: 'registry' }, '2026-01-02T00:00:00.000Z'),
      line('sidecar.reaped', { name: 'llama-server', pid: 14, reason: 'legacy-orphan' }, '2026-01-02T00:00:00.500Z'),
      line('sidecar.reaped', { name: 'llama-server', pid: 15, reason: 'unknown-reason' }, '2026-01-02T00:00:00.600Z'),
      started('2.0.15', 'unclean', '2026-01-02T00:00:01.000Z')
    ], identity, generatedAt)

    expect(summary.scope.soak).toMatchObject({
      uncleanShutdowns: 1,
      orphanReaps: { registry: 2, 'legacy-orphan': 1, afterUncleanExit: 2 }
    })
    expect(summary.scope.days['2026-01-01'].orphanReaps).toBe(1)
    expect(summary.scope.days['2026-01-02']).toMatchObject({ orphanReaps: 2, uncleanShutdowns: 1 })
    expect(summary.scope.days['2025-12-31']).toBeUndefined()
  })

  it('pre-registers every reveal outcome as a no-op or not, and counts no-ops from it', () => {
    expect(Object.keys(REVEAL_IS_NO_OP).sort()).toEqual([...REVEAL_OUTCOMES].sort())
    expect(REVEAL_IS_NO_OP).toEqual({ created: false, shown: false, 'already-visible': true, failed: true })

    const summary = summarizeAuditTrail([
      started('2.0.15', 'clean', '2026-01-01T00:00:00.000Z'),
      ...REVEAL_OUTCOMES.map((outcome) => line('reveal', { reason: 'tray', outcome }, '2026-01-01T00:00:01.000Z')),
      line('reveal', { reason: 'tray', outcome: 'unknown' }, '2026-01-01T00:00:02.000Z')
    ], identity, generatedAt)

    expect(summary.scope.soak.revealNoOps).toBe(2)
    expect(summary.scope.days['2026-01-01'].revealNoOps).toBe(2)
  })

  it('emits only allowlisted fields and no user text', () => {
    const summary = summarizeAuditTrail([
      line('sidecar.reaped', { name: 'llama-server', pid: 7, reason: 'registry' }, '2026-01-01T00:00:00.000Z'),
      line('app.started', {
        version: '2.0.15',
        prevShutdown: 'unclean',
        actor: 'jane.doe@acme.example'
      }, '2026-01-01T00:00:01.000Z'),
      line('app.crash', { fatal: false, message: 'Board budget failed at /var/tmp/metis/Meetings/Board.md' }),
      line('reveal', { outcome: 'failed', title: 'Board budget' }, '2026-01-01T00:00:02.000Z'),
      line('app.stall', { durationMs: 6000, phase: 'Board budget' }, '2026-01-01T00:00:03.000Z'),
      line('brain.index.quarantined', { file: 'Board.md', account: 'Acme' }, '2026-01-01T00:00:04.000Z')
    ], identity, generatedAt)
    const json = JSON.parse(JSON.stringify(summary)) as unknown

    const paths = new Set<string>()
    const strings: string[] = []
    const walk = (value: unknown, path: string): void => {
      if (value !== null && typeof value === 'object') {
        const mapped = path === 'events' || path === 'scope.events' || path === 'scope.days'
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if (path.endsWith('events')) expect(key).toMatch(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){0,4}$/)
          if (path === 'scope.days') expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
          walk(child, `${path ? `${path}.` : ''}${mapped ? '*' : key}`)
        }
        return
      }
      paths.add(path)
      if (typeof value === 'string') strings.push(value)
    }
    walk(json, '')

    const counts = (prefix: string): string[] => [
      'boots.started', 'boots.prevShutdown.clean', 'boots.prevShutdown.unclean', 'boots.prevShutdown.unknown',
      'stalls.under2s', 'stalls.2to5s', 'stalls.5to30s', 'stalls.30sPlus',
      'crashes.fatal', 'crashes.nonFatal', 'crashes.unclassified',
      'reveals.created', 'reveals.shown', 'reveals.already-visible', 'reveals.failed',
      'events.*'
    ].map((p) => prefix + p)
    const allowlist = [
      'kind', 'schema', 'generatedAt', 'app.version', 'app.platform', 'app.arch',
      'window.from', 'window.to', 'window.records', 'window.generations', 'window.truncated',
      ...counts(''),
      'scope.version', 'scope.from', 'scope.to', 'scope.records', 'scope.daySpan', 'scope.idleDays',
      ...counts('scope.'),
      ...['records', 'boots', 'uncleanShutdowns', 'stallsOver5s', 'orphanReaps', 'revealNoOps', 'brainIndexQuarantined']
        .map((f) => `scope.days.*.${f}`),
      'scope.soak.stallsOver5s', 'scope.soak.uncleanShutdowns', 'scope.soak.orphanReaps.registry',
      'scope.soak.orphanReaps.legacy-orphan', 'scope.soak.orphanReaps.afterUncleanExit',
      'scope.soak.revealNoOps', 'scope.soak.brainIndexQuarantined'
    ]
    expect([...paths].sort()).toEqual([...allowlist].sort())
    for (const value of strings) {
      const allowed = value === 'metis-diagnostics-summary' || Object.values(identity).includes(value) ||
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
      expect(allowed, value).toBe(true)
    }
  })

  it('bounds reads per generation and for the whole trail, newest first', async () => {
    const record = line('app.stall', { durationMs: 100 })
    const size = Buffer.byteLength(record) + 1
    const lines = (n: number): string => `${Array.from({ length: n }, () => record).join('\n')}\n`
    const files = { 'audit-1.log': lines(2), 'audit-2.log': lines(2), 'audit.log': lines(3) }
    await withTrail(files, async (auditTrailPath) => {
      const summary = await summarizeAuditGenerations(auditTrailPath, identity, generatedAt, {
        generationBytes: 2 * size + 5,
        trailBytes: 4 * size + 5
      })

      // The live file is clipped to its newest two whole lines; audit-2 fits; audit-1 is past the budget.
      expect(summary.window).toMatchObject({ records: 4, generations: 2, truncated: true })
    })
  })

  it('copyDiagnosticsSummary includes rotated generations', async () => {
    await withTrail({
      'audit-1.log': `${started('2.0.15', 'unclean', '2026-01-01T00:00:00.000Z')}\n`,
      'audit.log': `${line('app.stall', { durationMs: 6000 }, '2026-01-01T00:00:01.000Z')}\n`
    }, async (auditTrailPath) => {
      let copied = ''
      await copyDiagnosticsSummary({
        auditTrailPath,
        identity,
        now: () => generatedAt,
        writeText: (text) => {
          copied = text
        }
      })

      expect(JSON.parse(copied)).toMatchObject({
        schema: 2,
        window: { records: 2, generations: 2 },
        scope: { soak: { stallsOver5s: 1, uncleanShutdowns: 1 } }
      })
    })
  })
})
