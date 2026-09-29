import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PERMISSION_STATE, type PermissionState } from '@shared/screen-permission'
import { createScreenPermission, type ScreenPermissionDeps } from './screen-permission'

const CDHASH = 'a'.repeat(40)

function harness(overrides: Partial<ScreenPermissionDeps> = {}, initial: Partial<PermissionState> = {}) {
  let state: PermissionState = { ...DEFAULT_PERMISSION_STATE, ...initial }
  let status = 'denied'
  const writes: PermissionState[] = []
  const deps: ScreenPermissionDeps = {
    platform: 'darwin',
    appVersion: '1.9.7',
    execPath: '/Applications/Metis.app/Contents/MacOS/Metis',
    bundleId: 'com.mantu.asktoto',
    launchedAt: 1_000,
    readStatus: () => status,
    getState: () => state,
    setState: (next) => {
      state = next
      writes.push(next)
    },
    loadIdentity: vi.fn(async () => ({ cdhash: CDHASH, teamId: '', adhoc: true })),
    loadCopies: vi.fn(async () => [
      { path: '/Applications/Metis.app', version: '1.9.7' },
      { path: '/Users/someone/Applications/Metis.app', version: '1.5.4' }
    ]),
    now: () => 5_000,
    ...overrides
  }
  const sp = createScreenPermission(deps)
  return {
    sp,
    deps,
    writes,
    state: () => state,
    setStatus: (s: string) => {
      status = s
    }
  }
}

describe('createScreenPermission', () => {
  it('first ask is let through, then the same build is known to have been asked', () => {
    const h = harness()
    expect(h.sp.diagnose().state).toBe('not-asked')
    h.sp.noteAttempt()
    expect(h.state().screenAskedFor).toEqual({ version: '1.9.7', cdhash: '' })
    expect(h.sp.diagnose().state).toBe('denied')
  })

  it('loads identity and duplicate copies from the helper, excluding the running copy', async () => {
    const h = harness()
    await h.sp.loadInstallFacts()
    expect(h.deps.loadIdentity).toHaveBeenCalledWith('/Applications/Metis.app')
    expect(h.deps.loadCopies).toHaveBeenCalledWith('com.mantu.asktoto')
    expect(h.sp.identity()).toEqual({ version: '1.9.7', cdhash: CDHASH, teamId: '', adhoc: true })
    h.sp.noteAttempt()
    const d = h.sp.diagnose()
    expect(d).toMatchObject({ state: 'not-effective', reasons: ['duplicate-bundles'], action: 'repair' })
    expect(d.duplicates).toEqual([{ path: '/Users/someone/Applications/Metis.app', version: '1.5.4' }])
  })

  it('a success records the build that holds the grant; an update then reads identity-changed', async () => {
    const h = harness()
    await h.sp.loadInstallFacts()
    h.sp.noteOutcome(true)
    expect(h.state().screenGrantedFor).toEqual({ version: '1.9.7', cdhash: CDHASH })

    const next = harness({ appVersion: '1.9.8', loadCopies: async () => [] }, h.state())
    await next.sp.loadInstallFacts()
    expect(next.sp.diagnose()).toMatchObject({
      state: 'not-effective',
      reasons: ['identity-changed'],
      grantedFor: { version: '1.9.7', cdhash: CDHASH }
    })
  })

  it('a repeated success never rewrites the profile', () => {
    const h = harness()
    h.sp.noteOutcome(true)
    h.sp.noteOutcome(true)
    h.sp.noteOutcome(false)
    expect(h.writes).toHaveLength(1)
  })

  it('a status that turns granted mid-process reads needs-relaunch (read at launch)', () => {
    const h = harness()
    h.setStatus('granted')
    expect(h.sp.diagnose().state).toBe('needs-relaunch')
  })

  it('repair forgets per-build facts, so the next attempt asks afresh, and the re-probe is consumed once', () => {
    const h = harness({}, { screenGrantedFor: { version: '1.9.6', cdhash: 'b'.repeat(40) }, attestedOnAt: 10 })
    expect(h.sp.diagnose().state).toBe('not-effective')
    h.sp.noteRepairStarted()
    expect(h.state()).toMatchObject({ screenAskedFor: null, screenGrantedFor: null, attestedOnAt: 0, repairStartedAt: 5_000 })
    expect(h.sp.diagnose().state).toBe('not-asked')
    expect(h.sp.takePendingRepair()).toBe(true)
    expect(h.sp.takePendingRepair()).toBe(false)
  })

  it('a failed repair switches the action to the manual remove-then-add', () => {
    const h = harness({}, { screenGrantedFor: { version: '1.9.6', cdhash: 'b'.repeat(40) } })
    h.sp.noteRepairFailed()
    expect(h.sp.diagnose()).toMatchObject({ state: 'not-effective', action: 'open-settings', repairFailed: true })
  })

  it('attest records the time; after the relaunch a still-denied status is not-effective', () => {
    const h = harness()
    h.sp.attest()
    expect(h.state().attestedOnAt).toBe(5_000)
    const relaunched = harness({ launchedAt: 9_000 }, h.state())
    expect(relaunched.sp.diagnose()).toMatchObject({ state: 'not-effective', reasons: ['attested-then-relaunched'] })
  })

  it('off macOS nothing is loaded or persisted', async () => {
    const h = harness({ platform: 'win32', readStatus: () => 'unknown' })
    await h.sp.loadInstallFacts()
    h.sp.noteAttempt()
    h.sp.noteOutcome(true)
    expect(h.deps.loadIdentity).not.toHaveBeenCalled()
    expect(h.writes).toHaveLength(0)
  })
})
