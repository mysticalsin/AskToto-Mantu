/**
 * audit-log-chain.test.ts — MQA-232: the audit trail is tamper-EVIDENT, not just append-only.
 *
 * Behavioral where it can be: logger.ts routes non-app processes (this vitest worker) to a tmpdir, so
 * auditLog() here writes real lines through the real transport, and the verifier (the SAME module the
 * operator runs — scripts/verify-audit-log.mjs is plain ESM, imported directly) proves the chain over
 * them. The tamper cases mutate the produced lines and must be DETECTED — that is the whole control.
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, beforeAll } from 'vitest'
import { auditLog, auditLogPath, auditChainTip, AUDIT_ARCHIVE_GENERATIONS } from './logger'
// eslint-disable-next-line no-restricted-imports -- the verifier is deliberately the operator's own script
import { verifyAuditLines } from '../../scripts/verify-audit-log.mjs'

const readLines = (): string[] =>
  readFileSync(auditLogPath(), 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0)

beforeAll(() => {
  // A clean trail for this run: the tmp non-app log dir is shared across local vitest runs, and a
  // PRIOR run's tamper-case mutations would otherwise poison this run's verification.
  const p = auditLogPath()
  if (existsSync(p)) rmSync(p, { force: true })
})

describe('MQA-232 — every audit record chains to the one before it', () => {
  it('writes seq/prev on every record and the verifier proves the chain', () => {
    auditLog('app.crash', { probe: 'chain-1' })
    auditLog('app.crash', { probe: 'chain-2' })
    auditLog('app.crash', { probe: 'chain-3' })
    const lines = readLines()
    expect(lines.length).toBeGreaterThanOrEqual(3)
    const last = JSON.parse(lines[lines.length - 1]) as { seq: number; prev: string }
    expect(typeof last.seq).toBe('number')
    expect(last.prev).toMatch(/^([0-9a-f]{64}|GENESIS)$/)
    const r = verifyAuditLines(lines)
    expect(r.breaks).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.chained).toBe(lines.length)
  })

  it('the in-memory tip matches what a restart would resume from', () => {
    const tip = auditChainTip()
    const lines = readLines()
    expect(tip.seq).toBe((JSON.parse(lines[lines.length - 1]) as { seq: number }).seq)
  })

  it('DETECTS an edited record', () => {
    const lines = readLines()
    const tampered = [...lines]
    tampered[0] = tampered[0].replace('"probe":"chain-1"', '"probe":"edited"')
    const r = verifyAuditLines(tampered)
    expect(r.ok).toBe(false)
    expect(r.breaks.some((b: Record<string, unknown>) => /altered/.test(b.reason))).toBe(true)
  })

  it('DETECTS a deleted record', () => {
    const lines = readLines()
    const tampered = lines.filter((_, i) => i !== 1)
    const r = verifyAuditLines(tampered)
    expect(r.ok).toBe(false)
    expect(r.breaks.some((b: Record<string, unknown>) => /seq jumped|altered/.test(b.reason))).toBe(true)
  })

  it('DETECTS truncate-and-append (unchained line after the chain started)', () => {
    const lines = readLines()
    const r = verifyAuditLines([...lines, JSON.stringify({ ts: 'x', event: 'app.crash' })])
    expect(r.ok).toBe(false)
    expect(r.breaks.some((b: Record<string, unknown>) => /truncate-and-append/.test(b.reason))).toBe(true)
  })

  it('legacy pre-chain records are a reported prefix, never a false failure', () => {
    const lines = readLines()
    // A trail that starts with two legacy lines and then chains FROM the second one — exactly what
    // loadChainTip() produces on the first launch after this feature ships.
    const legacy1 = JSON.stringify({ ts: 'a', event: 'app.crash' })
    const legacy2 = JSON.stringify({ ts: 'b', event: 'app.crash' })
    void lines
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const chained = JSON.stringify({
      ts: 'c',
      seq: 1,
      prev: createHash('sha256').update(legacy2, 'utf8').digest('hex'),
      event: 'app.crash'
    })
    const r = verifyAuditLines([legacy1, legacy2, chained])
    expect(r.ok).toBe(true)
    expect(r.legacy).toBe(2)
    expect(r.chained).toBe(1)
  })

  it('retention is generational and bounded, not a single overwritten .old file', () => {
    // The rotation hook and its cap are wired in source; the constant is the operator-policy bound.
    expect(AUDIT_ARCHIVE_GENERATIONS).toBeGreaterThanOrEqual(10)
    const src = readFileSync(join(__dirname, 'logger.ts'), 'utf8')
    expect(src).toMatch(/audit\.transports\.file\.archiveLogFn/)
    expect(src).toMatch(/audit-\$\{Date\.now\(\)\}\.log/)
    expect(src).toMatch(/archives\.slice\(0, Math\.max\(0, archives\.length - AUDIT_ARCHIVE_GENERATIONS\)\)/)
  })
})

// tmpdir import kept referenced: the non-app log dir contract this test relies on lives there.
void tmpdir
