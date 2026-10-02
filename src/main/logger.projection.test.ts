import { readFileSync, rmSync } from 'node:fs'
import { describe, it, expect, afterAll, vi } from 'vitest'
import type { ObservabilityDetail } from './infra/observability/projection'

const logFixture = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return { root: mkdtempSync(join(tmpdir(), 'metis-logger-projection-')) }
})

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  tmpdir: () => logFixture.root
}))

import { auditLog, auditLogPath, setAuditActor } from './logger'

const readLastRecord = (): Record<string, unknown> => {
  const lines = readFileSync(auditLogPath(), 'utf8')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter(Boolean)
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
}

afterAll(() => rmSync(logFixture.root, { recursive: true, force: true }))

describe('auditLog observability projection', () => {
  it('projects app.crash, drops actor and unknown title, and scrubs a path-bearing message', () => {
    setAuditActor(() => 'jane.doe@acme-corp.example')
    const detail = {
      kind: 'boot',
      fatal: false,
      title: 'Board budget review',
      message: 'ENOENT: no such file or directory, open /var/tmp/metis/Meetings/Board budget.md'
    } as ObservabilityDetail<'app.crash'>

    auditLog('app.crash', detail)

    const record = readLastRecord()
    expect(record.event).toBe('app.crash')
    expect(record.actor).toBeUndefined()
    expect(record.title).toBeUndefined()
    expect(record.message).toBe('ENOENT: no such file or directory, open <path>')
    expect(JSON.stringify(record)).not.toContain('jane.doe')
    expect(JSON.stringify(record)).not.toContain('Board')
    expect(JSON.stringify(record)).not.toContain('Meetings')
  })

  it('leaves attributed events unchanged', () => {
    setAuditActor(() => 'jane.doe@acme-corp.example')

    auditLog('settings.changed', { probe: 'chain-1', nested: { kept: true } })

    const record = readLastRecord()
    expect(record.event).toBe('settings.changed')
    expect(record.actor).toBe('jane.doe@acme-corp.example')
    expect(record.probe).toBe('chain-1')
    expect(record.nested).toEqual({ kept: true })
  })
})
