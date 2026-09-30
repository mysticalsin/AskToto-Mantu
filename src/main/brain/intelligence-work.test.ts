import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import type { BackfillCompletion, BackfillRun, BackfillStartOptions } from './ingest'
import { resetMaintenanceGateForTests, settlePriorExit, startMaintenanceGate } from '../infra/scheduler/maintenance'
import { startIntelligenceWork } from './intelligence-work'
import { settleBrainWritesForTests } from '../test-helpers/settle-brain-writes'

vi.mock('electron')

let userData: string

beforeEach(() => {
  resetMaintenanceGateForTests({ listeners: true })
  userData = mkdtempSync(join(tmpdir(), 'intel-work-userdata-'))
  ;(app.getPath as ReturnType<typeof vi.fn>).mockImplementation((name: string) => {
    if (name === 'userData') return userData
    return join(userData, name)
  })
})

afterEach(async () => {
  await settleBrainWritesForTests()
  resetMaintenanceGateForTests({ listeners: true })
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness() {
  const extraction = gate<BackfillCompletion>()
  const recap = gate<string | undefined>()
  const save = vi.fn(async () => ({ ok: true }))
  const list = vi.fn(async () => [{ file: 'synthetic.md', mode: 'meeting', lines: [] }])
  let prerequisite!: Promise<unknown>
  const backfill = vi.fn((_options: BackfillStartOptions, beforeComplete: Promise<unknown>): BackfillRun => {
    prerequisite = beforeComplete
    return { result: { queued: 0, preparing: true }, completion: extraction.promise }
  })
  const deps = { list, generate: vi.fn(() => recap.promise), save, backfill, logFailure: vi.fn() }
  return { deps, extraction, recap, prerequisite: () => prerequisite }
}

describe('complete Intelligence work', () => {
  it('starts extraction without waiting for recaps, but cannot finish before both settle', async () => {
    const h = harness()
    const run = startIntelligenceWork(h.deps, 'click')
    expect(h.deps.backfill).toHaveBeenCalledTimes(1)
    expect(run.result).toEqual({ ran: true, queued: 0, preparing: true, recapped: 0 })
    const completed = vi.fn()
    void run.completion.then(completed)
    h.extraction.resolve({ ok: true, total: 1, failed: 0 })
    await Promise.resolve()
    expect(completed).not.toHaveBeenCalled()
    h.recap.resolve('Decisions and next steps.')
    await h.prerequisite()
    expect(h.deps.save).toHaveBeenCalledWith('synthetic.md', 'Decisions and next steps.', 'complete')
    await expect(run.completion).resolves.toEqual({ ok: true, recapped: 1 })
  })

  it.each(['missing', 'rejected', 'save-failed'])('does not call a %s recap complete', async (failure) => {
    const h = harness()
    if (failure === 'rejected') h.deps.generate.mockRejectedValueOnce(new Error('synthetic provider failure'))
    if (failure === 'save-failed') h.deps.save.mockResolvedValueOnce({ ok: false })
    const run = startIntelligenceWork(h.deps, 'click')
    h.recap.resolve(failure === 'missing' ? undefined : 'A recap')
    h.extraction.resolve({ ok: true, total: 1, failed: 0 })
    const result = await run.completion
    expect(result.ok).toBe(false)
    expect(result.recapped).toBe(0)
    expect(result.error).toMatch(/summar.*Retry/i)
    if (failure !== 'save-failed') expect(h.deps.save).not.toHaveBeenCalled()
    await expect(h.prerequisite()).resolves.toBeDefined()
  })

  it('retains successful summaries but reports a failed extraction pass', async () => {
    const h = harness()
    const run = startIntelligenceWork(h.deps, 'click')
    h.recap.resolve('A saved recap')
    h.extraction.resolve({ ok: false, error: 'write-failed', total: 1, failed: 1 })
    await expect(run.completion).resolves.toMatchObject({ ok: false, recapped: 1, error: expect.stringMatching(/Retry/) })
  })

  it('reports a missing provider with actionable setup guidance', async () => {
    const h = harness()
    h.deps.backfill.mockReturnValueOnce({
      result: { queued: 0, deferred: 'no-provider' },
      completion: Promise.resolve({ ok: false, error: 'no-provider', total: 1, failed: 0 })
    })
    const run = startIntelligenceWork(h.deps, 'click')
    h.recap.resolve(undefined)
    expect(run.result.ran).toBe(false)
    await expect(run.completion).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Connect an AI provider/) })
  })

  it('settles a failed meeting-list read safely without an unhandled rejection', async () => {
    const h = harness()
    h.deps.list.mockRejectedValueOnce(new Error('synthetic private path'))
    const run = startIntelligenceWork(h.deps, 'click')
    h.extraction.resolve({ ok: true, total: 0, failed: 0 })
    await expect(run.completion).resolves.toMatchObject({ ok: false, recapped: 0 })
    expect(h.deps.generate).not.toHaveBeenCalled()
    await expect(h.prerequisite()).resolves.toBeDefined()
  })

  it('finishes an empty verified pass without inventing summary work', async () => {
    const h = harness()
    h.deps.list.mockResolvedValueOnce([])
    const run = startIntelligenceWork(h.deps, 'click')
    h.extraction.resolve({ ok: true, total: 0, failed: 0 })
    await expect(run.completion).resolves.toEqual({ ok: true, recapped: 0 })
    expect(h.deps.generate).not.toHaveBeenCalled()
  })

  it('passes trigger user for a click and automatic for a scheduled pass', () => {
    const click = harness()
    startIntelligenceWork(click.deps, 'click')
    expect(click.deps.backfill).toHaveBeenCalledWith(expect.objectContaining({ force: true, trigger: 'user' }), expect.any(Promise))

    const schedule = harness()
    startIntelligenceWork(schedule.deps, 'schedule')
    expect(schedule.deps.backfill).toHaveBeenCalledWith(expect.objectContaining({ force: true, trigger: 'automatic' }), expect.any(Promise))
  })

  it('an automatic pass generates recaps only through the maintenance gate', async () => {
    resetMaintenanceGateForTests({ listeners: true })
    let uptime = 0
    const scheduled: Array<{ run: () => void; ms: number }> = []
    startMaintenanceGate({
      uptimeMs: () => uptime,
      interactiveActive: () => false,
      schedule: (run: () => void, ms: number) => { scheduled.push({ run, ms }) }
    })
    settlePriorExit('clean')
    const h = harness()
    const run = startIntelligenceWork(h.deps, 'schedule')
    await Promise.resolve()
    expect(h.deps.generate).not.toHaveBeenCalled()
    uptime = 121_000
    scheduled[0].run()
    await Promise.resolve()
    expect(h.deps.generate).toHaveBeenCalledOnce()
    h.recap.resolve('A gated recap')
    h.extraction.resolve({ ok: true, total: 1, failed: 0 })
    await expect(run.completion).resolves.toEqual({ ok: true, recapped: 1 })
    resetMaintenanceGateForTests({ listeners: true })
  })
})
