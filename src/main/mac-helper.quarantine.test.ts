import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('./logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => true
}))

import { macHelperPresent } from './mac-helper'
import { setHelperTrust } from './update/helper-quarantine'

describe('G86 — a quarantined or unverified helper is never spawned', () => {
  afterEach(() => setHelperTrust('trusted'))

  it('is present on darwin while trusted', () => {
    expect(macHelperPresent('darwin')).toBe(true)
  })

  it('is absent once re-verification quarantined it', () => {
    setHelperTrust('quarantined')
    expect(macHelperPresent('darwin')).toBe(false)
  })

  it('is absent while post-update verification is still pending', () => {
    setHelperTrust('pending')
    expect(macHelperPresent('darwin')).toBe(false)
  })
})
