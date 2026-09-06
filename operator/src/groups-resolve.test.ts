import { describe, expect, it } from 'vitest'
import { resolveSeatGroup, type IssuedLicenseGroupInput } from './groups-resolve'

const NOW = 1_725_000_000_000

function issued(partial: Partial<IssuedLicenseGroupInput> = {}): IssuedLicenseGroupInput {
  return { jti: 'j1', revoked: 0, exp: Math.floor(NOW / 1000) + 3600, group_id: 'g1', tier: 'metis', ...partial }
}

describe('resolveSeatGroup', () => {
  it('returns null when there is no issued license', () => {
    expect(resolveSeatGroup({ device_id: 'd1' }, null, NOW)).toBeNull()
  })

  it('returns null when the license is revoked', () => {
    expect(resolveSeatGroup({ device_id: 'd1' }, issued({ revoked: 1 }), NOW)).toBeNull()
  })

  it('returns null when the license is expired', () => {
    expect(resolveSeatGroup({ device_id: 'd1' }, issued({ exp: Math.floor(NOW / 1000) - 1 }), NOW)).toBeNull()
  })

  it('returns null when the license carries no group', () => {
    expect(resolveSeatGroup({ device_id: 'd1' }, issued({ group_id: null }), NOW)).toBeNull()
  })

  it('resolves group + tier for an active, group-bearing license', () => {
    expect(resolveSeatGroup({ device_id: 'd1' }, issued(), NOW)).toEqual({ groupId: 'g1', tier: 'metis' })
  })

  it('falls back to the default tier when the license omits one', () => {
    expect(resolveSeatGroup({ device_id: 'd1' }, issued({ tier: null }), NOW)).toEqual({ groupId: 'g1', tier: 'metis' })
  })
})
