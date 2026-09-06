import { describe, expect, it } from 'vitest'
import {
  approvalOf,
  isApprovedSeat,
  isRealSeat,
  licenseFromIngest,
  parseApproval,
  SEAT_NOT_APPROVED
} from './fleet'

describe('real seats vs usage-import', () => {
  it('drops usage-* and usage-import rows', () => {
    expect(
      isRealSeat({
        device_id: 'usage-deepseek-amaris',
        os: 'unknown',
        app_version: 'usage-import'
      })
    ).toBe(false)
    expect(
      isRealSeat({
        device_id: '6be389767fb160f7503de8e0227f4965',
        os: 'darwin',
        app_version: '1.8.3',
        hostname: 'Tonys-MacBook-Pro'
      })
    ).toBe(true)
  })
})

describe('approval gate', () => {
  it('treats pending and revoked as locked, approved or legacy license=approved as open', () => {
    expect(isApprovedSeat({ approval: 'pending', license: 'licensed' })).toBe(false)
    expect(isApprovedSeat({ approval: 'revoked', license: 'licensed' })).toBe(false)
    expect(isApprovedSeat({ approval: 'approved', license: 'unlicensed' })).toBe(true)
    expect(isApprovedSeat({ approval: null, license: 'approved' })).toBe(true)
    expect(approvalOf({ approval: null, license: 'approved' })).toBe('approved')
    expect(approvalOf({ approval: null, license: 'licensed' })).toBe('pending')
    expect(parseApproval('APPROVED')).toBe('approved')
    expect(SEAT_NOT_APPROVED).toMatch(/not approved/)
  })

  it('never lets a heartbeat self-approve', () => {
    expect(licenseFromIngest({ license: 'approved' })).toBeNull()
    expect(licenseFromIngest({ license: 'licensed', licenseLast4: 'cfc3' })).toBe('licensed · cfc3')
    expect(licenseFromIngest({ license: 'sk-ant-secret-value' })).toBeNull()
  })
})
