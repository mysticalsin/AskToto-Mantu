import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const electron = vi.hoisted(() => ({ app: { isPackaged: false } }))
vi.mock('electron', () => electron)
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

import {
  devLeasePublicKeyForTests,
  embeddedLicenseLeasePubkeyAvailable,
  getLicenseLeasePublicKeyRaw
} from './license-lease-key'

describe('license-lease-key fail-closed', () => {
  let originalResourcesPath: PropertyDescriptor | undefined
  let resources = ''

  beforeEach(() => {
    resources = mkdtempSync(join(tmpdir(), 'metis-lease-key-'))
    originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resources })
    electron.app.isPackaged = false
  })

  afterEach(() => {
    electron.app.isPackaged = false
    rmSync(resources, { recursive: true, force: true })
    if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    else delete (process as { resourcesPath?: string }).resourcesPath
  })

  it('falls back to DEV in unpackaged builds', () => {
    expect(getLicenseLeasePublicKeyRaw()).toBe(devLeasePublicKeyForTests())
    expect(embeddedLicenseLeasePubkeyAvailable()).toBe(false)
  })

  it('refuses DEV fallback when packaged without a provisioned key', () => {
    electron.app.isPackaged = true
    expect(() => getLicenseLeasePublicKeyRaw()).toThrow(/Refusing the DEV fallback/)
    expect(embeddedLicenseLeasePubkeyAvailable()).toBe(false)
  })

  it('refuses a provisioned key that still equals the DEV placeholder when packaged', () => {
    electron.app.isPackaged = true
    mkdirSync(join(resources, 'license-lease'), { recursive: true })
    writeFileSync(
      join(resources, 'license-lease', 'pubkey.json'),
      JSON.stringify({ algorithm: 'ed25519', publicKey: devLeasePublicKeyForTests() })
    )
    expect(() => getLicenseLeasePublicKeyRaw()).toThrow(/Refusing the DEV fallback/)
    expect(embeddedLicenseLeasePubkeyAvailable()).toBe(false)
  })

  it('accepts a non-DEV provisioned key when packaged', () => {
    electron.app.isPackaged = true
    const prod = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
    mkdirSync(join(resources, 'license-lease'), { recursive: true })
    writeFileSync(
      join(resources, 'license-lease', 'pubkey.json'),
      JSON.stringify({ algorithm: 'ed25519', publicKey: prod })
    )
    expect(getLicenseLeasePublicKeyRaw()).toBe(prod)
    expect(embeddedLicenseLeasePubkeyAvailable()).toBe(true)
  })
})
