import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PackageRuntimeContract } from '../features/components/speech-pack/package-contract'
import { isHelperQuarantined, setHelperTrust } from './helper-quarantine'
import { reverifyHelpers, type HelperReverifyDeps } from './helper-reverify'

const TEAM = 'TEAMID1234'
const verifiedContract: PackageRuntimeContract = {
  status: 'verified',
  profile: 'lean',
  inventory: {
    schema: 1,
    profile: 'lean',
    platform: 'darwin',
    arch: 'arm64',
    appVersion: '2.1.0',
    electronVersion: '1',
    sourceCommit: 'a'.repeat(40),
    coreFiles: [{ path: 'core/a.bin', bytes: 1, sha256: 'aa' }],
    identity: 'x'
  }
}

function deps(over: Partial<HelperReverifyDeps> = {}): HelperReverifyDeps & { log: ReturnType<typeof vi.fn> } {
  const log = vi.fn()
  return {
    platform: 'darwin',
    arch: 'arm64',
    resourcesPath: '/res',
    appBundlePath: '/Apps/Metis.app',
    contract: async () => verifiedContract,
    fileExists: () => true,
    codesignVerify: async () => true,
    getCodeIdentity: async () => ({ teamId: TEAM, adhoc: false }),
    sha256File: async () => 'aa',
    log,
    ...over
  } as HelperReverifyDeps & { log: ReturnType<typeof vi.fn> }
}

describe('G86 reverifyHelpers — helpers are re-checked after an update', () => {
  afterEach(() => setHelperTrust('trusted'))

  it('passes a signed app whose helpers share its team', async () => {
    const verdicts = await reverifyHelpers(deps())
    expect(verdicts.filter((v) => v.result === 'fail')).toEqual([])
    expect(verdicts.find((v) => v.id === 'mac-helper')?.result).toBe('pass')
    expect(isHelperQuarantined()).toBe(false)
  })

  it('quarantines a helper whose team differs from the signed app', async () => {
    const getCodeIdentity = vi.fn(async (path: string) => ({
      teamId: path.includes('ffmpeg') ? 'OTHER' : TEAM,
      adhoc: false
    }))
    const verdicts = await reverifyHelpers(deps({ getCodeIdentity }))
    expect(verdicts.find((v) => v.id === 'ffmpeg')).toEqual({ id: 'ffmpeg', result: 'fail', reason: 'team-mismatch' })
    expect(isHelperQuarantined()).toBe(true)
  })

  it('an unsigned app with a passing codesign check is integrity-only, not a failure', async () => {
    const verdicts = await reverifyHelpers(deps({ getCodeIdentity: async () => ({ teamId: '', adhoc: true }) }))
    expect(verdicts.find((v) => v.id === 'mac-helper')?.result).toBe('integrity-only')
    expect(isHelperQuarantined()).toBe(false)
  })

  it('a non-zero codesign result quarantines, and that helper is never asked for an identity', async () => {
    const getCodeIdentity = vi.fn(async () => ({ teamId: TEAM, adhoc: false }))
    const codesignVerify = vi.fn(async (path: string) => !path.includes('mac-helper'))
    const verdicts = await reverifyHelpers(deps({ codesignVerify, getCodeIdentity }))
    expect(verdicts.find((v) => v.id === 'mac-helper')).toEqual({
      id: 'mac-helper',
      result: 'fail',
      reason: 'codesign'
    })
    expect(isHelperQuarantined()).toBe(true)
    // mac-helper itself failed, so it is not trusted to read any identity.
    expect(getCodeIdentity).not.toHaveBeenCalled()
  })

  it('a core-file hash mismatch quarantines on every platform', async () => {
    const verdicts = await reverifyHelpers(deps({ platform: 'win32', sha256File: async () => 'bb' }))
    expect(verdicts).toEqual([{ id: 'inventory', result: 'fail', reason: 'sha-mismatch' }])
    expect(isHelperQuarantined()).toBe(true)
  })

  it('a missing core file quarantines', async () => {
    const verdicts = await reverifyHelpers(deps({ platform: 'win32', sha256File: async () => null }))
    expect(verdicts[0]).toEqual({ id: 'inventory', result: 'fail', reason: 'missing' })
  })

  it('a legacy-full package has no inventory to hash and is not quarantined for that', async () => {
    const verdicts = await reverifyHelpers(
      deps({ platform: 'win32', contract: async () => ({ status: 'legacy-full', profile: 'full', inventory: null }) })
    )
    expect(verdicts).toEqual([{ id: 'inventory', result: 'skipped-no-inventory' }])
    expect(isHelperQuarantined()).toBe(false)
  })

  it('never logs a team id, a cdhash or a path', async () => {
    const d = deps({
      getCodeIdentity: async (path: string) => ({ teamId: path.endsWith('.app') ? TEAM : 'OTHERTEAM', adhoc: false })
    })
    await reverifyHelpers(d)
    const logged = d.log.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).not.toContain(TEAM)
    expect(logged).not.toContain('OTHERTEAM')
    expect(logged).not.toContain('/res')
    expect(logged).toContain('team-mismatch')
  })
})
