import { mkdir, rename, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const closeFault = vi.hoisted(() => ({
  enabled: false,
  attempts: 0,
  retainedPaths: new Set<string>(),
  failedHandle: null as { close: () => Promise<void> } | null,
  opened: [] as { path: string; handle: object; target: { close: () => Promise<void> } }[],
  closeOutcomes: [] as { path: string; handle: object; promise: Promise<void>; fulfilled: boolean | null }[],
  statGate: null as {
    handle: object
    entered: () => void
    wait: Promise<void>
    release: () => void
    used: boolean
  } | null
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      const proxy = new Proxy(handle, {
        get(target, property) {
          if (property === 'close')
            return (...args: Parameters<typeof target.close>): Promise<void> => {
              if (closeFault.enabled && closeFault.retainedPaths.has(path)) {
                closeFault.attempts += 1
                if (closeFault.attempts === 1) {
                  closeFault.failedHandle = handle
                  return Promise.reject(new Error('injected first descriptor close failure'))
                }
              }
              const outcome = {
                path,
                handle: proxy as object,
                promise: Promise.resolve(),
                fulfilled: null as boolean | null
              }
              const operation = target.close(...args)
              outcome.promise = operation
              closeFault.closeOutcomes.push(outcome)
              void operation.then(
                () => {
                  outcome.fulfilled = true
                },
                () => {
                  outcome.fulfilled = false
                }
              )
              return operation
            }
          if (property === 'stat')
            return (...statArgs: Parameters<typeof target.stat>) => {
              const gate = closeFault.statGate
              const selected = gate && gate.handle === proxy && !gate.used
              const operation = target.stat(...statArgs)
              if (!selected) return operation
              gate.used = true
              return operation.then(async (value) => {
                gate.entered()
                await gate.wait
                return value
              })
            }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      closeFault.opened.push({ path, handle: proxy, target: handle })
      return proxy
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
  let p05Cleanup: Promise<void> | null = null
  let p05CleanupJoined = false
  let heldP08: {
    release: () => void
    body: Promise<void> | null
    check: Promise<void> | null
    joined: Promise<void> | null
    entered: boolean
    restore: (() => void) | null
    unlisten: (() => void) | null
    launch: NonNullable<ReturnType<typeof verifyQaPersistenceLaunchEnvelope>> | null
    root: Awaited<ReturnType<typeof prepareQaProfileRoot>> | null
    settled: boolean
    closing: boolean
    finalizing: Promise<void> | null
  } | null = null

  afterEach(async () => {
    if (heldP08) {
      const owner = heldP08
      owner.closing = true
      owner.release()
      owner.finalizing ??= (async () => {
        await owner.body?.then(
          () => {},
          () => {}
        )
        await owner.joined
        owner.unlisten?.()
        if (owner.check && !owner.entered) throw new Error('P08-original-held-boundary-unreached')
        if (owner.launch && !owner.settled) {
          if (owner.root) retireQaProfileRoot(owner.root)
          await settleQaProfileRootPreparation(owner.launch)
          owner.settled = true
        }
      })()
      await owner.finalizing
    }
    if (closeFault.failedHandle && !p05CleanupJoined) {
      if (!p05Cleanup) throw new Error('P05-retained-handle-cleanup-not-joined')
      await p05Cleanup
      p05CleanupJoined = true
    }
    const closeResults = await Promise.allSettled(closeFault.closeOutcomes.map((item) => item.promise))
    if (closeResults.some((result) => result.status === 'rejected'))
      throw new Error('profile-descriptor-close-not-joined-successfully')
    heldP08?.restore?.()
    await cleanup?.()
    cleanup = undefined
    closeFault.enabled = false
    closeFault.attempts = 0
    closeFault.retainedPaths.clear()
    closeFault.failedHandle = null
    closeFault.opened.length = 0
    closeFault.closeOutcomes.length = 0
    closeFault.statGate = null
    p05Cleanup = null
    p05CleanupJoined = false
    heldP08 = null
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
      if (closeFault.failedHandle) {
        p05Cleanup = closeFault.failedHandle.close()
        await p05Cleanup
        p05CleanupJoined = true
      }
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

  it('retires on injected Mac UID drift while a held physical check is awaiting the directory descriptor', async ({
    signal
  }) => {
    const owner: NonNullable<typeof heldP08> = {
      release: () => {},
      body: null,
      check: null,
      joined: null,
      entered: false,
      restore: null,
      unlisten: null,
      launch: null,
      root: null,
      settled: false,
      closing: false,
      finalizing: null
    }
    heldP08 = owner
    const body = (async () => {
      if (signal.aborted || owner.closing) throw new Error('P08-context-already-aborted')
      const physical = await createQaFixtureProfile()
      cleanup = physical.cleanup
      if (signal.aborted || owner.closing) throw new Error('P08-context-aborted-after-setup')
      applyLegacyPersistenceNativeKeyDefault()
      setQaFixtureUserDataPath(physical.profile.path)
      const challenge = newQaFixtureChallenge()
      const launch = verifyQaPersistenceLaunchEnvelope(signQaFixtureLaunch(challenge, physical), challenge)
      expect(launch).not.toBeNull()
      owner.launch = launch
      const root = await prepareQaProfileRoot(launch!)
      owner.root = root
      if (signal.aborted || owner.closing) throw new Error('P08-context-aborted-after-preparation')

      if (process.platform !== 'darwin') {
        await expect(assertQaProfilePhysicalCurrent(root)).resolves.toBeUndefined()
        if (signal.aborted || owner.closing) throw new Error('P08-context-aborted-after-physical-check')
        retireQaProfileRoot(root)
        await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
        owner.settled = true
        return
      }

      const uid = process.getuid?.()
      const effectiveUid = process.geteuid?.()
      expect(uid).toBeDefined()
      expect(effectiveUid).toBe(uid)
      let release!: () => void
      let held!: () => void
      const isHeld = new Promise<void>((resolve) => {
        held = resolve
      })
      const resume = new Promise<void>((resolve) => {
        release = resolve
      })
      await assertQaProfilePhysicalCurrent(root)
      if (signal.aborted || owner.closing) throw new Error('P08-context-aborted-after-healthy-check')
      const parentHandle = closeFault.opened.find((item) => item.path === physical.parent.path)?.handle
      const profileHandle = closeFault.opened.find((item) => item.path === physical.profile.path)?.handle
      expect(parentHandle).toBeDefined()
      expect(profileHandle).toBeDefined()
      expect(parentHandle).not.toBe(profileHandle)
      closeFault.statGate = {
        handle: parentHandle!,
        entered: () => {
          owner.entered = true
          held()
        },
        wait: resume,
        release,
        used: false
      }
      const uidSpy = vi.spyOn(process, 'getuid').mockReturnValue(uid!)
      owner.release = release
      owner.restore = () => uidSpy.mockRestore()
      if (signal.aborted) release()
      signal.addEventListener('abort', release, { once: true })
      owner.unlisten = () => signal.removeEventListener('abort', release)
      if (signal.aborted || owner.closing) throw new Error('P08-context-already-aborted')
      const check = assertQaProfilePhysicalCurrent(root)
      owner.check = check
      owner.joined = check.then(
        () => {},
        () => {}
      )
      await isHeld
      if (signal.aborted || owner.closing) throw new Error('P08-context-aborted')
      uidSpy.mockReturnValue(uid! + 1)
      release()
      await expect(check).rejects.toThrow()
      expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
      release()
      await owner.joined
      owner.unlisten()
      owner.unlisten = null
      uidSpy.mockReturnValue(uid!)
      if (signal.aborted || owner.closing) throw new Error('P08-context-aborted')
      expect(() => assertQaProfileCurrent(root)).toThrow('QA_PROFILE_OWNER_UNAVAILABLE')
      retireQaProfileRoot(root)
      await expect(settleQaProfileRootPreparation(launch!)).resolves.toBeUndefined()
      owner.settled = true
      const parentClose = closeFault.closeOutcomes.filter((item) => item.handle === parentHandle)
      const profileClose = closeFault.closeOutcomes.filter((item) => item.handle === profileHandle)
      expect(parentClose).toHaveLength(1)
      expect(profileClose).toHaveLength(1)
      await Promise.all([parentClose[0]!.promise, profileClose[0]!.promise])
      expect(parentClose[0]?.fulfilled).toBe(true)
      expect(profileClose[0]?.fulfilled).toBe(true)
    })()
    owner.body = body
    return body
  })
})
