import { describe, expect, it, vi } from 'vitest'
import type { ScreenDiagnosis, ScreenDiagnosisState } from '@shared/ipc'
import { acquireLoopbackScreenSource, isOrphanScreenSourcesRejection, type LoopbackScreenSourceDeps } from './loopback-grant'

type Src = { id: string; usable: boolean }

const diagnosis = (state: ScreenDiagnosisState): ScreenDiagnosis => ({
  state,
  reasons: [],
  action: 'none',
  duplicates: [],
  grantedFor: null,
  repairFailed: false
})

function deps(state: ScreenDiagnosisState, getSources: () => Promise<Src[]>, platform = 'darwin') {
  const d: LoopbackScreenSourceDeps<Src> = {
    platform,
    diagnose: () => diagnosis(state),
    getSources: vi.fn(getSources),
    isUsable: (s) => s.usable,
    noteAttempt: vi.fn(),
    noteOutcome: vi.fn(),
    audit: vi.fn(),
    log: vi.fn(),
    wait: async () => {}
  }
  return d
}

describe('acquireLoopbackScreenSource — the display-media handler contract (M2-0429)', () => {
  for (const state of ['denied', 'restricted', 'not-effective', 'needs-relaunch'] as const) {
    it(`${state}: denies immediately, never calls getSources, audits screen_permission_denied`, async () => {
      const d = deps(state, async () => [{ id: 's', usable: true }])
      await expect(acquireLoopbackScreenSource(d)).resolves.toBeNull()
      expect(d.getSources).not.toHaveBeenCalled()
      expect(d.noteAttempt).not.toHaveBeenCalled()
      expect(d.audit).toHaveBeenCalledWith('capture.failed', { reason: 'screen_permission_denied', phase: 'listen', state })
    })
  }

  it('granted: binds to the first usable source and records the success', async () => {
    const d = deps('granted', async () => [{ id: 'blank', usable: false }, { id: 's1', usable: true }])
    await expect(acquireLoopbackScreenSource(d)).resolves.toEqual({ id: 's1', usable: true })
    expect(d.noteOutcome).toHaveBeenCalledWith(true)
    expect(d.audit).not.toHaveBeenCalled()
  })

  it('not-asked: the first attempt reaches macOS (it raises the prompt) and is recorded as asked', async () => {
    const d = deps('not-asked', async () => [])
    await expect(acquireLoopbackScreenSource(d)).resolves.toBeNull()
    expect(d.noteAttempt).toHaveBeenCalledTimes(1)
    expect(d.getSources).toHaveBeenCalledTimes(3)
    expect(d.noteOutcome).toHaveBeenCalledWith(false)
    expect(d.audit).toHaveBeenCalledWith('capture.failed', { reason: 'loopback_no_screen_source', phase: 'listen' })
  })

  it('a darwin getSources rejection is handled: resolves null, never rejects', async () => {
    const d = deps('granted', () => Promise.reject('Failed to get sources.'))
    await expect(acquireLoopbackScreenSource(d)).resolves.toBeNull()
    expect(d.log).toHaveBeenCalledWith('[display-media] getSources failed (attempt 1): Failed to get sources.')
  })

  it('Windows is not gated by the macOS diagnosis', async () => {
    const d = deps('denied', async () => [{ id: 'w', usable: true }], 'win32')
    await expect(acquireLoopbackScreenSource(d)).resolves.toEqual({ id: 'w', usable: true })
    expect(d.noteAttempt).not.toHaveBeenCalled()
  })
})

describe('isOrphanScreenSourcesRejection', () => {
  it('recognises Electron’s bare darwin rejection, as a string or an Error', () => {
    expect(isOrphanScreenSourcesRejection('Failed to get sources.', 'darwin')).toBe(true)
    expect(isOrphanScreenSourcesRejection(new Error('Failed to get sources.'), 'darwin')).toBe(true)
  })

  it('leaves every other rejection, and other platforms, to the crash handler', () => {
    expect(isOrphanScreenSourcesRejection('Failed to get sources.', 'win32')).toBe(false)
    expect(isOrphanScreenSourcesRejection(new Error('Cannot read properties of undefined'), 'darwin')).toBe(false)
    expect(isOrphanScreenSourcesRejection(undefined, 'darwin')).toBe(false)
  })
})
