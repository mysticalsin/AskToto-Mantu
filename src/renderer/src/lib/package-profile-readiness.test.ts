import { describe, expect, it } from 'vitest'
import {
  hasVerifiedLeanPackageProfile,
  packageModeFromStateSnapshot,
  resolveProductPackageMode
} from './package-profile-readiness'

const verifiedLean = {
  status: 'verified',
  profile: 'lean',
  identity: 'profile-hash',
  platform: 'darwin',
  arch: 'arm64',
  reason: null
}

describe('main-verified package profile projection', () => {
  it('admits only an explicit verified lean resource projection', () => {
    expect(hasVerifiedLeanPackageProfile(verifiedLean)).toBe(true)
    expect(hasVerifiedLeanPackageProfile({ ...verifiedLean, status: 'legacy-full', profile: 'full' })).toBe(false)
    expect(hasVerifiedLeanPackageProfile({ ...verifiedLean, status: 'development', profile: 'development' })).toBe(
      false
    )
    expect(hasVerifiedLeanPackageProfile({ ...verifiedLean, status: 'invalid' })).toBe(false)
    expect(hasVerifiedLeanPackageProfile({ ...verifiedLean, profile: 'full' })).toBe(false)
  })

  it.each([
    null,
    undefined,
    {},
    'lean',
    { ...verifiedLean, identity: null },
    { ...verifiedLean, reason: 'mismatch' }
  ])('fails closed for malformed/unverified profile metadata: %j', (value) =>
    expect(hasVerifiedLeanPackageProfile(value)).toBe(false))

  it('keeps old full UI compatibility while treating an explicit invalid main result as closed', () => {
    expect(resolveProductPackageMode(undefined)).toBe('legacy')
    expect(resolveProductPackageMode(null)).toBe('invalid')
    expect(resolveProductPackageMode({ ...verifiedLean, status: 'legacy-full', profile: 'full' })).toBe('legacy')
    expect(resolveProductPackageMode({ ...verifiedLean, status: 'invalid' })).toBe('invalid')
    expect(resolveProductPackageMode({ ...verifiedLean, profile: 'full' })).toBe('legacy')
    expect(resolveProductPackageMode({ ...verifiedLean, identity: null })).toBe('invalid')
    expect(resolveProductPackageMode(verifiedLean)).toBe('lean')
    expect(packageModeFromStateSnapshot({ packageProfile: verifiedLean })).toBe('lean')
    expect(packageModeFromStateSnapshot({ packageProfile: { ...verifiedLean, status: 'invalid' } })).toBe('invalid')
    expect(packageModeFromStateSnapshot({ packageProfile: null })).toBe('invalid')
    expect(packageModeFromStateSnapshot({ packageProfile: undefined })).toBe('invalid')
    expect(packageModeFromStateSnapshot(null)).toBe('invalid')
    expect(packageModeFromStateSnapshot({ selectedEngine: 'whisper' })).toBe('legacy')
  })
})
