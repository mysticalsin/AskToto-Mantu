import { describe, expect, it } from 'vitest'
import { DEFAULT_PERMISSION_STATE, type PermissionState } from '@shared/screen-permission'
import {
  appBundlePathFromExecPath,
  diagnoseScreenPermission,
  isTranslocatedPath,
  otherBundleCopies,
  sameIdentity,
  screenCaptureMayProceed,
  type ScreenDiagnoseInput
} from './diagnose'

const LAUNCHED_AT = 1_000_000
const THIS_BUILD = { version: '1.9.7', cdhash: 'a'.repeat(40) }
const OLD_BUILD = { version: '1.9.6', cdhash: 'b'.repeat(40) }
const COPY = { path: '/Users/someone/Applications/Metis.app', version: '1.5.4' }

function input(overrides: Partial<ScreenDiagnoseInput> = {}, state: Partial<PermissionState> = {}): ScreenDiagnoseInput {
  return {
    platform: 'darwin',
    status: 'denied',
    statusAtLaunch: 'denied',
    identity: THIS_BUILD,
    state: { ...DEFAULT_PERMISSION_STATE, ...state },
    launchedAt: LAUNCHED_AT,
    duplicates: [],
    translocated: false,
    ...overrides
  }
}

describe('diagnoseScreenPermission — macOS', () => {
  it('granted when the status was granted from launch', () => {
    const d = diagnoseScreenPermission(input({ status: 'granted', statusAtLaunch: 'granted' }))
    expect(d).toMatchObject({ state: 'granted', action: 'none', reasons: [] })
    expect(screenCaptureMayProceed(d)).toBe(true)
  })

  it('needs-relaunch when the grant appeared during this process (macOS applies it to the next launch)', () => {
    const d = diagnoseScreenPermission(input({ status: 'granted', statusAtLaunch: 'denied' }))
    expect(d).toMatchObject({ state: 'needs-relaunch', action: 'relaunch' })
    expect(screenCaptureMayProceed(d)).toBe(false)
  })

  it('not-asked when this build never let an attempt through (CGPreflight reads denied before any ask)', () => {
    const d = diagnoseScreenPermission(input())
    expect(d).toMatchObject({ state: 'not-asked', action: 'request' })
    // The first attempt must still reach macOS: it is what raises the system prompt.
    expect(screenCaptureMayProceed(d)).toBe(true)
  })

  it('not-asked again for a new build, because the ask was recorded for another identity', () => {
    const d = diagnoseScreenPermission(input({}, { screenAskedFor: OLD_BUILD }))
    expect(d.state).toBe('not-asked')
  })

  it('denied with no history once this build has been asked', () => {
    const d = diagnoseScreenPermission(input({}, { screenAskedFor: THIS_BUILD }))
    expect(d).toMatchObject({ state: 'denied', action: 'open-settings', reasons: [] })
    expect(screenCaptureMayProceed(d)).toBe(false)
  })

  it('not-effective with identity-changed when another build last captured, even before this build asked', () => {
    const d = diagnoseScreenPermission(input({}, { screenGrantedFor: OLD_BUILD }))
    expect(d).toMatchObject({ state: 'not-effective', action: 'repair', reasons: ['identity-changed'] })
    // Names the build that holds the grant, so the copy can say which one.
    expect(d.grantedFor).toEqual(OLD_BUILD)
    expect(screenCaptureMayProceed(d)).toBe(false)
  })

  it('same version but a different cdhash is an identity change (a rebuilt ad-hoc binary)', () => {
    const d = diagnoseScreenPermission(input({}, { screenGrantedFor: { version: THIS_BUILD.version, cdhash: 'c'.repeat(40) } }))
    expect(d.reasons).toContain('identity-changed')
  })

  it('not-effective with duplicate-bundles once asked and still denied, and lists the copies', () => {
    const d = diagnoseScreenPermission(input({ duplicates: [COPY] }, { screenAskedFor: THIS_BUILD }))
    expect(d).toMatchObject({ state: 'not-effective', action: 'repair', reasons: ['duplicate-bundles'], duplicates: [COPY] })
  })

  it('duplicates alone do not block the first ask', () => {
    const d = diagnoseScreenPermission(input({ duplicates: [COPY] }))
    expect(d).toMatchObject({ state: 'not-asked', reasons: ['duplicate-bundles'] })
  })

  it('attested then relaunched and still denied is not-effective, never another trip to Settings', () => {
    const d = diagnoseScreenPermission(input({}, { attestedOnAt: LAUNCHED_AT - 5_000 }))
    expect(d).toMatchObject({ state: 'not-effective', action: 'repair', reasons: ['attested-then-relaunched'] })
    expect(d.action).not.toBe('open-settings')
  })

  it('an attestation made in this very process waits for its relaunch', () => {
    const d = diagnoseScreenPermission(input({}, { attestedOnAt: LAUNCHED_AT + 10 }))
    expect(d).toMatchObject({ state: 'needs-relaunch', action: 'relaunch' })
  })

  it('translocated: the fix is moving the app, reported as a reason', () => {
    const d = diagnoseScreenPermission(input({ translocated: true }, { screenAskedFor: THIS_BUILD }))
    expect(d).toMatchObject({ state: 'not-effective', action: 'move-to-applications', reasons: ['translocated'] })
  })

  it('a failed repair keeps the state but switches the action to the manual remove-then-add', () => {
    const d = diagnoseScreenPermission(input({}, { screenGrantedFor: OLD_BUILD, repairFailed: true }))
    expect(d).toMatchObject({ state: 'not-effective', action: 'open-settings', repairFailed: true })
  })

  it('restricted (MDM) stays distinct, never mapped to denied or unknown, and offers no action', () => {
    const d = diagnoseScreenPermission(input({ status: 'restricted' }, { screenGrantedFor: OLD_BUILD }))
    expect(d).toMatchObject({ state: 'restricted', action: 'none' })
    expect(screenCaptureMayProceed(d)).toBe(false)
  })

  it('grantedFor is null when the last capturing build is this one', () => {
    const d = diagnoseScreenPermission(input({ status: 'granted', statusAtLaunch: 'granted' }, { screenGrantedFor: THIS_BUILD }))
    expect(d.grantedFor).toBeNull()
  })
})

describe('diagnoseScreenPermission — other platforms', () => {
  it('win32 follows the capture probe: granted, denied, or not yet probed', () => {
    expect(diagnoseScreenPermission(input({ platform: 'win32', status: 'granted' })).state).toBe('granted')
    expect(diagnoseScreenPermission(input({ platform: 'win32', status: 'denied' }))).toMatchObject({ state: 'denied', action: 'open-settings' })
    expect(diagnoseScreenPermission(input({ platform: 'win32', status: 'unknown' }))).toMatchObject({ state: 'not-asked', action: 'request' })
  })

  it('linux needs no screen permission', () => {
    expect(diagnoseScreenPermission(input({ platform: 'linux' }))).toMatchObject({ state: 'granted', action: 'none' })
  })
})

describe('identity and install helpers', () => {
  it('sameIdentity compares cdhash only when both sides know it', () => {
    expect(sameIdentity(THIS_BUILD, { version: THIS_BUILD.version, cdhash: '' })).toBe(true)
    expect(sameIdentity(THIS_BUILD, OLD_BUILD)).toBe(false)
    expect(sameIdentity(THIS_BUILD, { version: THIS_BUILD.version, cdhash: 'd'.repeat(40) })).toBe(false)
  })

  it('derives the bundle path and detects translocation from the executable path', () => {
    expect(appBundlePathFromExecPath('/Applications/Metis.app/Contents/MacOS/Metis')).toBe('/Applications/Metis.app')
    expect(appBundlePathFromExecPath('/usr/local/bin/electron')).toBeNull()
    expect(isTranslocatedPath('/private/var/folders/x/AppTranslocation/ABC/d/Metis.app/Contents/MacOS/Metis')).toBe(true)
    expect(isTranslocatedPath('/Applications/Metis.app/Contents/MacOS/Metis')).toBe(false)
  })

  it('otherBundleCopies drops the running copy only', () => {
    const own = { path: '/Applications/Metis.app', version: '1.9.7' }
    expect(otherBundleCopies([own, COPY], '/Applications/Metis.app/')).toEqual([COPY])
    expect(otherBundleCopies([own, COPY], null)).toEqual([own, COPY])
  })
})
