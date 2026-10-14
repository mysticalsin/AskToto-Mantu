import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  contract: {
    status: 'verified' as string,
    profile: 'lean',
    inventory: { identity: 'package-identity' }
  },
  acquire: vi.fn(),
  legacy: vi.fn()
}))

vi.mock('electron', () => ({ app: { getVersion: () => '43.6.0' } }))
vi.mock('./package-runtime-state', () => ({
  getPackageRuntimeContract: async () => state.contract,
  assertLegacyRuntimeClosure: state.legacy
}))
vi.mock('./runtime-components', () => ({ runtimeTargetFor: () => ({ packageProfileIdentity: 'target' }) }))
vi.mock('./runtime-lease', () => ({ acquireFeatureRuntime: state.acquire }))

import { acquirePackageRuntimeLease, configureRuntimeAdmissionAuthority } from './runtime-admission'
import { invalidateRuntimeExecutionAuthority } from './runtime-execution-authority'

describe('optional runtime execution admission', () => {
  beforeEach(() => {
    state.contract = {
      status: 'verified',
      profile: 'lean',
      inventory: { identity: 'package-identity' }
    }
    state.acquire.mockReset()
    state.legacy.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    configureRuntimeAdmissionAuthority(async () => true)
  })

  it('refuses a fresh lease when the current user or policy authority is revoked', async () => {
    configureRuntimeAdmissionAuthority(async () => false)
    await expect(acquirePackageRuntimeLease('offline-asr')).rejects.toThrow(/authority was revoked/i)
    expect(state.acquire).not.toHaveBeenCalled()
  })

  it('releases a lease if authority changes while package identity is being rechecked', async () => {
    const lease = { release: vi.fn(async () => undefined) }
    state.acquire.mockResolvedValue(lease)
    let reads = 0
    configureRuntimeAdmissionAuthority(async () => ++reads < 3)

    await expect(acquirePackageRuntimeLease('offline-asr')).rejects.toThrow(/authority was revoked/i)
    expect(state.acquire).toHaveBeenCalledOnce()
    expect(lease.release).toHaveBeenCalledOnce()
  })

  it('does not let a held provider acquisition adopt authority restored after request revocation', async () => {
    let enterAcquisition!: () => void
    let resolveAcquisition!: (lease: { release: () => Promise<void> }) => void
    const entered = new Promise<void>((resolve) => {
      enterAcquisition = resolve
    })
    const acquired = new Promise<{ release: () => Promise<void> }>((resolve) => {
      resolveAcquisition = resolve
    })
    const lease = { release: vi.fn(async () => undefined) }
    state.acquire.mockImplementation(async () => {
      enterAcquisition()
      return acquired
    })
    configureRuntimeAdmissionAuthority(async () => true)

    const request = acquirePackageRuntimeLease('offline-asr')
    await entered
    invalidateRuntimeExecutionAuthority()
    configureRuntimeAdmissionAuthority(async () => true)
    resolveAcquisition(lease)

    await expect(request).rejects.toThrow(/authority was revoked/i)
    expect(lease.release).toHaveBeenCalledOnce()
  })

  it('keeps the established full runtime path independent of lean authority callbacks', async () => {
    state.contract = { status: 'verified', profile: 'full', inventory: { identity: 'full' } }
    configureRuntimeAdmissionAuthority(async () => false)

    await expect(acquirePackageRuntimeLease('offline-asr')).resolves.toBeNull()
    expect(state.legacy).toHaveBeenCalledOnce()
    expect(state.acquire).not.toHaveBeenCalled()
  })
})
