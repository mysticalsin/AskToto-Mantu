import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildQaRunOwnerChild,
  createQaFixtureProfile,
  signQaFixtureHeartbeat,
  signQaFixtureLaunch,
  startQaRunOwnerChild,
  type QaFixtureProfile,
  type QaRunOwnerChild
} from '../../../scripts/qa/fixtures/persistence-run-owner-support'

describe('compiled hosted persistence run owner', () => {
  let child: QaRunOwnerChild | undefined
  let profile: QaFixtureProfile | undefined
  let fixtureOutput: string | undefined

  afterEach(async () => {
    try {
      await child?.releaseFixtureGates()
    } finally {
      await child?.terminate()
    }
    child = undefined
    await profile?.cleanup()
    profile = undefined
    if (fixtureOutput) await rm(fixtureOutput, { recursive: true, force: true })
    fixtureOutput = undefined
  })

  it('uses the actual first-show proof, inherited pipe, signed launch, profile and guarded registry', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-build-'))
    const entry = await buildQaRunOwnerChild(fixtureOutput)
    child = startQaRunOwnerChild(entry, profile.profile.path)

    const helloBytes = await child.readFrame()
    const hello = JSON.parse(helloBytes.toString('utf8')) as { bootChallenge: string; schema: string }
    expect(Object.keys(hello).sort()).toEqual(['bootChallenge', 'schema'])
    expect(hello.schema).toBe('metis-persistence-qa-hello/v1')
    expect(hello.bootChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    child.sendCommand('duplicate-prepare')
    await expect(child.waitForReport('duplicate-prepare')).resolves.toMatchObject({
      refusal: 'run-already-owned'
    })

    child.sendCommand('create-root')
    await expect(child.waitForReport('root')).resolves.toMatchObject({ created: true })

    await child.sendFrame(signQaFixtureHeartbeat(1))
    child.sendCommand('check')
    await expect(child.waitForReport('current')).resolves.toMatchObject({ current: true })

    await child.sendFrame(Buffer.from('{', 'utf8'))
    child.sendCommand('check')
    await expect(child.waitForReport('current')).resolves.toMatchObject({ current: false })

    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true, samePromise: true })
  })

  it.each([
    ['no bound window', 'no-window'],
    ['unshown bound window', 'unshown'],
    ['hidden bound window', 'hidden'],
    ['uncommitted main frame', 'uncommitted']
  ])('refuses %s before hello, pipe use or profile preparation', async (_label, mode) => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-refusal-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path, mode)
    await expect(child.waitForReport('refused')).resolves.toMatchObject({ code: 'window-proof-unavailable' })
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    expect(child.receivedFrameCount).toBe(0)
  })

  it('keeps the first-show proof across hide and permanently retires it across A-to-B-to-A navigation', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-window-lifetime-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    child.sendCommand('hide-check')
    await expect(child.waitForReport('hidden')).resolves.toMatchObject({ current: true })
    child.sendCommand('navigate-aba')
    await expect(child.waitForReport('navigation-aba')).resolves.toMatchObject({ current: false })
    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true })
  })

  it('uses the shared terminal path for EOF before launch, mid-frame and after activation', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-eof-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    child.endInput()
    await expect(child.waitForReport('refused')).resolves.toMatchObject({ code: 'transport-unavailable' })

    await child.terminate()
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    await child.readFrame()
    await child.sendPartialFrameAndEnd(Buffer.from('{"schema":', 'utf8'), 6)
    await expect(child.waitForReport('refused')).resolves.toMatchObject({ code: 'transport-unavailable' })

    await child.terminate()
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })
    child.endInput()
    child.sendCommand('check')
    await expect(child.waitForReport('current')).resolves.toMatchObject({ current: false })

    await child.terminate()
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const activeHello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(activeHello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })
    child.closeOutput()
    child.sendCommand('check')
    await expect(child.waitForReport('current')).resolves.toMatchObject({ current: false })
  })

  it.each([
    'navigate',
    'replace',
    'close',
    'render-process-loss'
  ] as const)('retires the in-flight handshake on first-show document %s events before active publication', async (event) => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-window-retirement-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    await expect(child.waitForReport('preparing')).resolves.toMatchObject({ type: 'preparing' })
    child.sendCommand('hold-profile-preparation')
    await expect(child.waitForReport('profile-preparation-hold-ready')).resolves.toMatchObject({
      type: 'profile-preparation-hold-ready'
    })
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('profile-preparation-stat-held')).resolves.toMatchObject({
      type: 'profile-preparation-stat-held'
    })
    child.retireWindowDuringPreparation(event)
    await expect(child.waitForReport('preparation-window-retired')).resolves.toMatchObject({ event })
    await expect(child.waitForReport('refused')).resolves.toMatchObject({ code: 'window-proof-unavailable' })
    child.sendCommand('release-profile-preparation')
    await expect(child.waitForReport('profile-preparation-descriptors-settled')).resolves.toEqual({
      type: 'profile-preparation-descriptors-settled',
      settledDescriptorCount: 2,
      parentCloseCount: 1,
      profileCloseCount: 1,
      distinctHandles: true
    })
    expect(child.reportCount('active')).toBe(0)
  })

  it.each([
    'invalid heartbeat signature',
    'replayed/decreasing sequence',
    'oversized active frame'
  ])('retires an active run immediately for %s', async (fault) => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-active-fault-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    if (fault === 'replayed/decreasing sequence') {
      await child.sendFrame(signQaFixtureHeartbeat(2))
      child.sendCommand('check')
      await expect(child.waitForReport('current')).resolves.toMatchObject({ current: true })
      await child.sendFrame(signQaFixtureHeartbeat(1))
    } else if (fault === 'oversized active frame') {
      await child.sendInvalidFrameLength(65_537)
    } else {
      const heartbeat = signQaFixtureHeartbeat(1)
      const envelope = JSON.parse(heartbeat.toString('utf8')) as { signature: string }
      envelope.signature = `${envelope.signature[0] === 'A' ? 'B' : 'A'}${envelope.signature.slice(1)}`
      await child.sendFrame(Buffer.from(JSON.stringify(envelope), 'utf8'))
    }
    child.sendCommand('check')
    await expect(child.waitForReport('current')).resolves.toMatchObject({ current: false })
  })

  it('accepts only a higher-generation successor after full settlement and rejects the old run at RootRegistry', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-successor-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const firstHello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(firstHello.bootChallenge, profile, { runGeneration: 1 }))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })
    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true, samePromise: true })

    child.sendCommand('successor')
    const nextHello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(nextHello.bootChallenge, profile, { runGeneration: 2 }))
    await expect(child.waitForReport('successor-active')).resolves.toMatchObject({ current: true })
    child.sendCommand('stale-owner')
    await expect(child.waitForReport('stale-owner')).resolves.toMatchObject({ refused: true, callbacks: 0 })
    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true, samePromise: true })
  })

  it('retires from its scheduled signed-expiry deadline without an intervening status call', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-expiry-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile, { expiresAt: Date.now() + 1_500 }))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 1_700))
    child.sendCommand('check')
    await expect(child.waitForReport('current')).resolves.toMatchObject({ current: false })
  })

  it('refuses a malformed compiled stamp before issuing a challenge or opening the fixed transport', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-bad-stamp-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput, '{'), profile.profile.path)
    await expect(child.waitForReport('refused')).resolves.toMatchObject({ code: 'build-stamp-missing' })
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    expect(child.receivedFrameCount).toBe(0)
  })

  it('rechecks the actual run after a held gateway bind and publishes no root after userData changes', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-held-registry-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    child.sendCommand('create-root-held')
    await expect(child.waitForReport('gateway-held')).resolves.toMatchObject({ type: 'gateway-held' })
    child.sendCommand('change-userdata-resume')
    await expect(child.waitForReport('root-held')).resolves.toMatchObject({
      created: false,
      gatewayPublished: false
    })
    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true })
  })

  it('keeps a timed-out handshake reserved until held profile descriptors actually close', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-held-profile-timeout-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    child.sendCommand('hold-profile-preparation')
    await expect(child.waitForReport('profile-preparation-hold-ready')).resolves.toMatchObject({
      type: 'profile-preparation-hold-ready'
    })
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('profile-preparation-stat-held')).resolves.toMatchObject({
      type: 'profile-preparation-stat-held'
    })

    await expect(child.waitForReport('refused', 18_000)).resolves.toMatchObject({ code: 'transport-unavailable' })
    child.sendCommand('duplicate-prepare')
    await expect(child.waitForReport('duplicate-prepare')).resolves.toMatchObject({
      refusal: 'run-already-owned'
    })
    child.sendCommand('release-profile-preparation')
    await expect(child.waitForReport('profile-preparation-descriptors-settled')).resolves.toEqual({
      type: 'profile-preparation-descriptors-settled',
      settledDescriptorCount: 2,
      parentCloseCount: 1,
      profileCloseCount: 1,
      distinctHandles: true
    })
    expect(child.reportCount('active')).toBe(0)
  })

  it('keeps a partial-frame transport failure reserved until held profile preparation actually settles', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-partial-held-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    child.sendCommand('hold-profile-preparation')
    await expect(child.waitForReport('profile-preparation-hold-ready')).resolves.toMatchObject({
      type: 'profile-preparation-hold-ready'
    })
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('profile-preparation-stat-held')).resolves.toMatchObject({
      type: 'profile-preparation-stat-held'
    })

    await child.sendPartialFrameAndEnd(Buffer.from('{"schema":"partial-heartbeat"}', 'utf8'), 9)
    await expect(child.waitForReport('refused')).resolves.toMatchObject({ code: 'transport-unavailable' })
    child.sendCommand('duplicate-prepare')
    await expect(child.waitForReport('duplicate-prepare')).resolves.toMatchObject({
      refusal: 'run-already-owned'
    })
    child.sendCommand('release-profile-preparation')
    await expect(child.waitForReport('profile-preparation-descriptors-settled')).resolves.toEqual({
      type: 'profile-preparation-descriptors-settled',
      settledDescriptorCount: 2,
      parentCloseCount: 1,
      profileCloseCount: 1,
      distinctHandles: true
    })
    expect(child.reportCount('active')).toBe(0)
  })

  it('retires on the real scheduled heartbeat-age timer without an intervening owner assertion', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-heartbeat-age-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile, { expiresAt: Date.now() + 60_000 }))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    await new Promise<void>((resolve) => setTimeout(resolve, 31_000))
    child.sendCommand('check')
    await expect(child.waitForReport('current')).resolves.toMatchObject({ current: false })
  }, 40_000)

  it('retains run capacity and the same failed settlement after an actual profile descriptor close failure', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-run-owner-close-failure-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    child.sendCommand('fail-profile-close')
    await expect(child.waitForReport('profile-close-failure-armed')).resolves.toEqual({
      type: 'profile-close-failure-armed',
      targetRole: 'profile-parent',
      ownClose: true
    })
    child.sendCommand('settle')
    await expect(child.waitForReport('profile-close-fault-observed')).resolves.toEqual({
      type: 'profile-close-fault-observed',
      targetRole: 'profile-parent',
      hookInvocations: 1,
      originalCloseCalls: 0,
      retained: true,
      error: 'injected-close'
    })
    await expect(child.waitForReport('profile-other-close-observed')).resolves.toEqual({
      type: 'profile-other-close-observed',
      targetRole: 'profile',
      fulfilled: true
    })
    await expect(child.waitForReport('settlement-failed')).resolves.toMatchObject({
      available: true,
      samePromise: true,
      sameInjectedError: true
    })
    child.sendCommand('duplicate-prepare')
    await expect(child.waitForReport('duplicate-prepare')).resolves.toMatchObject({
      refusal: 'run-already-owned'
    })
    child.sendCommand('release-failed-close')
    await expect(child.waitForReport('profile-failed-handle-release')).resolves.toEqual({
      type: 'profile-failed-handle-release',
      state: 'fulfilled',
      retained: true
    })
  })
})
