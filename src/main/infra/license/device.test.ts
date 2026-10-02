import { describe, expect, it, vi, beforeEach } from 'vitest'
import { formatSerialDisplay, hashDeviceId, isUsableSerial, readHardwareIdentity } from './device'
import { DEVICE_HASH_PREFIX } from '@shared/license-types'
import { createHash } from 'node:crypto'
import { WINDOWS_POWERSHELL } from '../../win-security'

// M2-0147 — device.ts used to spawn a bare 'powershell.exe' for every Windows identity query, which
// Windows' CreateProcess search order resolves against the CURRENT WORKING DIRECTORY before PATH: an
// attacker-writable cwd (Métis launched from a Downloads folder, a mapped drive) could plant its own
// powershell.exe and have it run with the app's privileges. win-security.ts's WINDOWS_POWERSHELL is the
// one pinned, absolute System32 path every other main-process spawn already uses for this exact reason.
const h = vi.hoisted(() => ({ fake: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: h.fake }
})

describe('readHardwareIdentity(win32) — every PowerShell query is the pinned System32 binary (M2-0147)', () => {
  beforeEach(() => {
    h.fake.mockReset()
    h.fake.mockImplementation((_cmd: string, args: string[]) => {
      const script = args[args.length - 1] as string
      if (/Win32_BIOS/.test(script)) return 'To be filled by O.E.M.' // placeholder — forces the MachineGuid fallback
      if (/MachineGuid/.test(script)) return 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
      if (/Win32_ComputerSystem/.test(script)) return 'Surface Laptop 5'
      throw new Error(`unexpected PowerShell script: ${script}`)
    })
  })

  it('D1: reads the Windows serial and model through the pinned System32 PowerShell, never a bare name', () => {
    const identity = readHardwareIdentity('win32')
    expect(identity).toEqual({ serial: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', model: 'Surface Laptop 5' })
    expect(h.fake).toHaveBeenCalledTimes(3) // BIOS serial, MachineGuid fallback, computer model
    for (const call of h.fake.mock.calls) {
      expect(call[0]).toBe(WINDOWS_POWERSHELL)
    }
  })
})

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
