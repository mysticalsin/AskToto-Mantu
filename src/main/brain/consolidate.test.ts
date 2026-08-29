import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import type { StreamHandlers, StreamOptions, StreamHandle } from '../llm/shared'
import { getSettings, setSettings, setApiKey } from '../store'
import { canConsolidateToday, recordConsolidationPass, runConsolidationIfDue } from './consolidate'
import { whenIndexWritesSettle } from './ingest'

vi.mock('electron')

// Same fake as ingest-progress.test.ts: every completion resolves instantly with an empty-but-valid
// extraction — only startBackfill's synchronous QUEUEING is under test here, not extraction content.
vi.mock('../llm', () => ({
  createStream: vi.fn((opts: StreamOptions & { handlers: StreamHandlers }): StreamHandle => {
    queueMicrotask(() => {
      opts.handlers.onDelta('{}')
      opts.handlers.onDone({})
    })
    return { abort: () => {} }
  })
}))

let userData: string
let meetingsFolder: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'asktoto-consolidate-test-'))
  meetingsFolder = mkdtempSync(join(tmpdir(), 'asktoto-consolidate-meetings-'))
  ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
    if (name === 'userData') return userData
    return join(userData, name)
  })
  // See ingest-progress.test.ts's identical sweep: keeps anthropic the ONLY eligible candidate
  // regardless of what real provider env vars this machine happens to export.
  for (const name of Object.keys(process.env)) {
    if (name.endsWith('_API_KEY')) vi.stubEnv(name, undefined)
  }
  setSettings({ meetingsFolder, encryptTranscripts: false })
})

afterEach(async () => {
  await whenIndexWritesSettle()
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  rmSync(meetingsFolder, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('canConsolidateToday', () => {
  it('true by default (enabled, 0 of maxPassesPerDay spent)', () => {
    expect(canConsolidateToday(getSettings())).toBe(true)
  })

  it('false the instant brainConsolidation.enabled is off, even with a fresh budget', () => {
    setSettings({ brainConsolidation: { enabled: false, maxPassesPerDay: 2, preferLocal: true } })
    expect(canConsolidateToday(getSettings())).toBe(false)
  })

  it('false once today\u2019s recorded passes reach maxPassesPerDay', async () => {
    setSettings({ brainConsolidation: { enabled: true, maxPassesPerDay: 2, preferLocal: true } })
    const s = getSettings()
    expect(canConsolidateToday(s)).toBe(true)
    await recordConsolidationPass(s)
    expect(canConsolidateToday(s)).toBe(true) // 1 of 2 spent
    await recordConsolidationPass(s)
    expect(canConsolidateToday(s)).toBe(false) // 2 of 2 spent
  })

  it('a lower maxPassesPerDay (1) is spent after a single pass', async () => {
    setSettings({ brainConsolidation: { enabled: true, maxPassesPerDay: 1, preferLocal: true } })
    const s = getSettings()
    await recordConsolidationPass(s)
    expect(canConsolidateToday(s)).toBe(false)
  })

  it('the budget resets on a new calendar day', async () => {
    setSettings({ brainConsolidation: { enabled: true, maxPassesPerDay: 1, preferLocal: true } })
    const s = getSettings()
    const yesterday = Date.now() - 25 * 60 * 60 * 1000
    await recordConsolidationPass(s, yesterday)
    expect(canConsolidateToday(s, yesterday)).toBe(false) // spent yesterday
    expect(canConsolidateToday(s)).toBe(true) // today's counter is fresh
  })
})

describe('recordConsolidationPass', () => {
  it('increments the durable per-day counter across separate reads (survives a fresh settings read)', async () => {
    const s = getSettings()
    const first = await recordConsolidationPass(s)
    expect(first.passes).toBe(1)
    const second = await recordConsolidationPass(getSettings())
    expect(second.passes).toBe(2)
  })

  it('two consolidate.ts instances agree on the same day key (no drift from the caller\u2019s own now())', async () => {
    const s = getSettings()
    const fixedNow = new Date('2026-03-15T10:00:00Z').getTime()
    const r = await recordConsolidationPass(s, fixedNow)
    expect(r.date).toBe('2026-03-15')
  })
})

describe('runConsolidationIfDue', () => {
  it('reports disabled and never scans when brainConsolidation.enabled is false', async () => {
    setSettings({ brainConsolidation: { enabled: false, maxPassesPerDay: 2, preferLocal: true } })
    writeFileSync(join(meetingsFolder, 'meeting-1.md'), '---\ndate: 2026-01-01\n---\nhello', 'utf8')
    const r = await runConsolidationIfDue(getSettings())
    expect(r).toEqual({ ran: false, queued: 0, reason: 'disabled' })
  })

  it('reports budget-spent once today\u2019s passes are exhausted, without re-scanning', async () => {
    setSettings({ brainConsolidation: { enabled: true, maxPassesPerDay: 1, preferLocal: true } })
    const s = getSettings()
    await recordConsolidationPass(s)
    writeFileSync(join(meetingsFolder, 'meeting-1.md'), '---\ndate: 2026-01-01\n---\nhello', 'utf8')
    const r = await runConsolidationIfDue(getSettings())
    expect(r).toEqual({ ran: false, queued: 0, reason: 'budget-spent' })
  })

  it('queues every not-yet-ingested meeting and records exactly one pass when something was found', async () => {
    setApiKey('anthropic', 'fake-test-key-not-real')
    writeFileSync(join(meetingsFolder, 'meeting-1.md'), '---\ndate: 2026-01-01\n---\nhello', 'utf8')
    writeFileSync(join(meetingsFolder, 'meeting-2.md'), '---\ndate: 2026-01-02\n---\nworld', 'utf8')
    const s = getSettings()
    expect(canConsolidateToday(s)).toBe(true)
    const r = await runConsolidationIfDue(s)
    expect(r.ran).toBe(true)
    expect(r.queued).toBe(2)
    // One pass recorded for this call, not one per queued file.
    const after = getSettings()
    expect(canConsolidateToday(after)).toBe(true) // default budget is 2/day
    await recordConsolidationPass(after)
    expect(canConsolidateToday(getSettings())).toBe(false)
  })

  it('never spends the daily budget on a tick that finds nothing to do', async () => {
    setApiKey('anthropic', 'fake-test-key-not-real')
    // No meetings on disk at all.
    const s = getSettings()
    const r = await runConsolidationIfDue(s)
    expect(r).toEqual({ ran: false, queued: 0 })
    expect(canConsolidateToday(getSettings())).toBe(true) // budget untouched
  })
})
