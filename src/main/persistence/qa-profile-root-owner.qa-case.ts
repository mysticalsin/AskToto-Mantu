import { mkdir, open, rename, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const closeFault = vi.hoisted(() => ({
  enabled: false,
  attempts: 0,
  retainedPaths: new Set<string>(),
  failedHandle: null as { close: () => Promise<void> } | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close')
            return async () => {
              if (closeFault.enabled && closeFault.retainedPaths.has(path)) {
                closeFault.attempts += 1
                if (closeFault.attempts === 1) {
                  closeFault.failedHandle = handle
                  throw new Error('injected first descriptor close failure')
                }
              }
              await handle.close()
            }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})

import { setQaFixtureUserDataPath } from '../../../scripts/qa/fixtures/persistence-run-owner.electron-host'
import { applyLegacyPersistenceNativeKeyDefault } from './native-key-intent'
import {
  createQaFixtureProfile,
  newQaFixtureChallenge,
  signQaFixtureLaunch
} from '../../../scripts/qa/fixtures/persistence-run-owner-support'
import {
  newQaPersistenceBootChallenge,
  qaPersistenceCanonical,
  verifyQaPersistenceLaunchEnvelope,
  readVerifiedQaPersistenceLaunch
} from './qa-run-protocol'
import {
  assertQaProfileCurrent,
  assertQaProfilePhysicalCurrent,
  prepareQaProfileRoot,
  retireQaProfileRoot,
  settleQaProfileRootPreparation
} from './qa-profile-root-owner'

describe('compiled hosted persistence profile owner', () => {
  let cleanup: (() => Promise<void>) | undefined

  afterEach(async () => {
    closeFault.enabled = false
    closeFault.attempts = 0
    closeFault.retainedPaths.clear()
    closeFault.failedHandle = null
    await cleanup?.()
    cleanup = undefined
  })

  it('owns a real signed parent/profile pair and remains current after an owned child addition', async () => {
    const physical = await createQaFixtureProfile()
    cleanup = physical.cleanup
    applyLegacyPersistenceNativeKeyDefault()
    setQaFixtureUserDataPath(physical.profile.path)
    const challenge = newQaFixtureChallenge()
    const launch = verifyQaPersistenceLaunchEnvelope(signQaFixtureLaunch(challenge, physical), challenge)
    expect(launch).not.toBeNull()
    expect(readVerifiedQaPersistenceLaunch(launch!)?.profile.path).toBe(physical.profile.path)

    const root = await prepareQaProfileRoot(launch!)
    assertQaProfileCurrent(root)
    await assertQaProfilePhysicalCurrent(root)
    await mkdir(`${physical.profile.path}/owned-child`)
    await assertQaProfilePhysicalCurrent(root)
    retireQaProfileRoot(root)
    await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
    await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
    expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
  })

  it('rejects a forged launch before acquiring profile descriptors', async () => {
    const physical = await createQaFixtureProfile()
    cleanup = physical.cleanup
    applyLegacyPersistenceNativeKeyDefault()
    setQaFixtureUserDataPath(physical.profile.path)
    const challenge = newQaPersistenceBootChallenge()
    const envelope = signQaFixtureLaunch(challenge, physical)
    const value = JSON.parse(envelope.toString('utf8')) as { signature: string; payload: string; schema: string }
    value.signature = `${value.signature[0] === 'A' ? 'B' : 'A'}${value.signature.slice(1)}`
    const forged = Buffer.from(qaPersistenceCanonical(value), 'utf8')
    const launch = verifyQaPersistenceLaunchEnvelope(forged, challenge)
    expect(launch).toBeNull()
    await expect(prepareQaProfileRoot(launch as never)).rejects.toThrow('QA_PROFILE_LAUNCH_UNVERIFIED')
  })

  it('permanently retires the pinned profile after named-directory replacement, even after spelling restoration', async () => {
    const physical = await createQaFixtureProfile()
    cleanup = physical.cleanup
    applyLegacyPersistenceNativeKeyDefault()
    setQaFixtureUserDataPath(physical.profile.path)
    const challenge = newQaFixtureChallenge()
    const launch = verifyQaPersistenceLaunchEnvelope(signQaFixtureLaunch(challenge, physical), challenge)
    expect(launch).not.toBeNull()
    const root = await prepareQaProfileRoot(launch!)
    const movedPath = `${physical.profile.path}-held`
    await rename(physical.profile.path, movedPath)
    await mkdir(physical.profile.path, { mode: 0o700 })
    await expect(assertQaProfilePhysicalCurrent(root)).rejects.toThrow()
    await rm(physical.profile.path, { recursive: true, force: true })
    await rename(movedPath, physical.profile.path)
    expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
    retireQaProfileRoot(root)
    await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
  })

  it('permanently retires the profile after userData changes, even when the original path is restored', async () => {
    const physical = await createQaFixtureProfile()
    cleanup = physical.cleanup
    applyLegacyPersistenceNativeKeyDefault()
    setQaFixtureUserDataPath(physical.profile.path)
    const challenge = newQaFixtureChallenge()
    const launch = verifyQaPersistenceLaunchEnvelope(signQaFixtureLaunch(challenge, physical), challenge)
    expect(launch).not.toBeNull()
    const root = await prepareQaProfileRoot(launch!)
    setQaFixtureUserDataPath(`${physical.profile.path}-replacement`)
    expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_RUN_CONTEXT_CHANGED')
    setQaFixtureUserDataPath(physical.profile.path)
    expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
    retireQaProfileRoot(root)
    await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
  })

  it('attempts both retained descriptor closes and keeps the original close rejection observable', async () => {
    const physical = await createQaFixtureProfile()
    cleanup = physical.cleanup
    applyLegacyPersistenceNativeKeyDefault()
    setQaFixtureUserDataPath(physical.profile.path)
    const challenge = newQaFixtureChallenge()
    const launch = verifyQaPersistenceLaunchEnvelope(signQaFixtureLaunch(challenge, physical), challenge)
    expect(launch).not.toBeNull()
    closeFault.retainedPaths.add(physical.parent.path)
    closeFault.retainedPaths.add(physical.profile.path)
    await prepareQaProfileRoot(launch!)

    closeFault.enabled = true
    const settlement = settleQaProfileRootPreparation(launch!)
    try {
      await expect(settlement).rejects.toThrow('injected first descriptor close failure')
      expect(settleQaProfileRootPreparation(launch!)).toBe(settlement)
      expect(closeFault.attempts).toBe(2)
    } finally {
      closeFault.enabled = false
      await closeFault.failedHandle?.close()
    }
  })

  it.each([
    'getuid',
    'geteuid'
  ] as const)('rejects injected Mac %s drift after a real pinned directory open and keeps the retirement after restoration', async (getter) => {
    const physical = await createQaFixtureProfile()
    cleanup = physical.cleanup
    applyLegacyPersistenceNativeKeyDefault()
    setQaFixtureUserDataPath(physical.profile.path)
    const challenge = newQaFixtureChallenge()
    const launch = verifyQaPersistenceLaunchEnvelope(signQaFixtureLaunch(challenge, physical), challenge)
    expect(launch).not.toBeNull()
    const root = await prepareQaProfileRoot(launch!)

    if (process.platform === 'darwin') {
      const uid = process.getuid?.()
      const effectiveUid = process.geteuid?.()
      expect(uid).toBeDefined()
      expect(effectiveUid).toBeDefined()
      const uidSpy = vi.spyOn(process, getter).mockReturnValue(((getter === 'getuid' ? uid : effectiveUid) ?? 0) + 1)
      try {
        await expect(assertQaProfilePhysicalCurrent(root)).rejects.toThrow()
      } finally {
        uidSpy.mockRestore()
      }
      expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
      await expect(assertQaProfilePhysicalCurrent(root)).rejects.toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
    } else {
      await expect(assertQaProfilePhysicalCurrent(root)).resolves.toBeUndefined()
    }
    retireQaProfileRoot(root)
    await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
  })

  it('retires on injected Mac UID drift while a held physical check is awaiting the directory descriptor', async () => {
    const physical = await createQaFixtureProfile()
    cleanup = physical.cleanup
    applyLegacyPersistenceNativeKeyDefault()
    setQaFixtureUserDataPath(physical.profile.path)
    const challenge = newQaFixtureChallenge()
    const launch = verifyQaPersistenceLaunchEnvelope(signQaFixtureLaunch(challenge, physical), challenge)
    expect(launch).not.toBeNull()
    const root = await prepareQaProfileRoot(launch!)

    if (process.platform !== 'darwin') {
      await expect(assertQaProfilePhysicalCurrent(root)).resolves.toBeUndefined()
      retireQaProfileRoot(root)
      await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
      return
    }

    const uid = process.getuid?.()
    const effectiveUid = process.geteuid?.()
    expect(uid).toBeDefined()
    expect(effectiveUid).toBe(uid)
    const probe = await open(process.execPath, 'r')
    const prototype = Object.getPrototypeOf(probe) as { stat: (...args: unknown[]) => Promise<unknown> }
    const originalStat = prototype.stat
    await probe.close()
    let release!: () => void
    let held!: () => void
    const isHeld = new Promise<void>((resolve) => {
      held = resolve
    })
    const resume = new Promise<void>((resolve) => {
      release = resolve
    })
    let didHold = false
    prototype.stat = async function (this: unknown, ...args: unknown[]) {
      const value = await originalStat.apply(this, args)
      if (!didHold) {
        didHold = true
        held()
        await resume
      }
      return value
    }
    const uidSpy = vi.spyOn(process, 'getuid').mockReturnValue(uid! + 1)
    try {
      const check = assertQaProfilePhysicalCurrent(root)
      await isHeld
      await expect(check).rejects.toThrow()
      expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
    } finally {
      release()
      prototype.stat = originalStat
      uidSpy.mockRestore()
    }
    expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
    await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
  })
})
