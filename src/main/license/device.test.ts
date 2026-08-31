import { describe, expect, it } from 'vitest'
import { formatSerialDisplay, hashDeviceId, isUsableSerial } from './device'
import { DEVICE_HASH_PREFIX } from '@shared/license-types'
import { createHash } from 'node:crypto'

describe('device identity', () => {
  it('hashed device id is stable for the same inputs', () => {
    const a = hashDeviceId('C02X1234KQ8L', 'darwin')
    const b = hashDeviceId('C02X1234KQ8L', 'darwin')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(
      createHash('sha256').update(`${DEVICE_HASH_PREFIX}\0C02X1234KQ8L\0darwin`, 'utf8').digest('hex')
    )
  })

  it('hashed device id changes when the serial or platform changes', () => {
    const base = hashDeviceId('C02X1234KQ8L', 'darwin')
    expect(hashDeviceId('C02X1234KQ8L', 'win32')).not.toBe(base)
    expect(hashDeviceId('OTHERSERIAL', 'darwin')).not.toBe(base)
  })

  it('rejects placeholder serials so the card never shows a fake serial', () => {
    expect(isUsableSerial('')).toBe(false)
    expect(isUsableSerial('None')).toBe(false)
    expect(isUsableSerial('To be filled by O.E.M.')).toBe(false)
    expect(isUsableSerial('Default string')).toBe(false)
    expect(isUsableSerial('C02X1234KQ8L')).toBe(true)
  })

  it('groups a hardware serial and last-fours an install UUID', () => {
    expect(formatSerialDisplay('C02X1234KQ8L', 'hardware')).toBe('C02X · 1234 · KQ8L')
    expect(formatSerialDisplay('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'install')).toBe('···7890')
  })
})
