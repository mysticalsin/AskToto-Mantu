import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'metis-time-saved-test') }
}))
vi.mock('./logger', () => ({
  auditLog: vi.fn(),
  mainLog: { warn: vi.fn(), error: vi.fn() }
}))

import { appendTimeSavedEvent, parseTimeSavedLine, readTimeSavedEvents, summarizeTimeSaved } from './time-saved-log'

function tmpLog(): string {
  return join(mkdtempSync(join(tmpdir(), 'ts-log-')), 'time-saved.jsonl')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('append-only event log', () => {
  it('appends a real note-taking estimate and refuses a zero', () => {
    const file = tmpLog()
    const ok = appendTimeSavedEvent({ kind: 'note-taking', estimatedMinutes: 3, ids: { meeting: 'a.md' } }, file)
    expect(ok.ok).toBe(true)
    const no = appendTimeSavedEvent({ kind: 'note-taking', estimatedMinutes: 0 }, file)
    expect(no.ok).toBe(false)
    const events = readTimeSavedEvents(file)
    expect(events).toHaveLength(1)
    expect(events[0].estimatedMinutes).toBe(3)
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('skips a corrupt line instead of inventing totals', () => {
    const file = tmpLog()
    writeFileSync(
      file,
      [
        JSON.stringify({ kind: 'email-summary', timestamp: 1, estimatedMinutes: 4 }),
        'not-json',
        JSON.stringify({ kind: 'mcp-push', timestamp: 2, estimatedMinutes: 3, connector: 'outlook' })
      ].join('\n') + '\n',
      'utf8'
    )
    const s = summarizeTimeSaved(file)
    expect(s.savedMinutes).toBe(7)
    expect(s.events).toBe(2)
    expect(s.recent[0].kind).toBe('mcp-push')
  })
})

describe('parseTimeSavedLine', () => {
  it('rejects an unknown kind or a negative estimate', () => {
    expect(parseTimeSavedLine(JSON.stringify({ kind: 'vanity', timestamp: 1, estimatedMinutes: 9 }))).toBeNull()
    expect(parseTimeSavedLine(JSON.stringify({ kind: 'note-taking', timestamp: 1, estimatedMinutes: -4 }))).toBeNull()
  })
})
