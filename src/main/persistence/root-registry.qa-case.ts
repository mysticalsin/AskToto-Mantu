import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildQaRunOwnerChild,
  createQaFixtureProfile,
  signQaFixtureLaunch,
  startQaRunOwnerChild,
  type QaFixtureProfile,
  type QaRunOwnerChild
} from '../../../scripts/qa/fixtures/persistence-run-owner-support'

describe('actual RootRegistry hosted-run guard', () => {
  let child: QaRunOwnerChild | undefined
  let profile: QaFixtureProfile | undefined
  let fixtureOutput: string | undefined

  afterEach(async () => {
    await child?.terminate()
    child = undefined
    await profile?.cleanup()
    profile = undefined
    if (fixtureOutput) await rm(fixtureOutput, { recursive: true, force: true })
    fixtureOutput = undefined
  })

  it('binds a real guarded root and refuses missing, forged and overridden QA owners before callbacks', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-root-registry-build-'))
    const entry = await buildQaRunOwnerChild(fixtureOutput)
    child = startQaRunOwnerChild(entry, profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as {
      bootChallenge: string
      schema: string
    }
    expect(hello.schema).toBe('metis-persistence-qa-hello/v1')
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    child.sendCommand('create-root')
    await expect(child.waitForReport('root')).resolves.toMatchObject({ created: true })
    child.sendCommand('registry-negative')
    await expect(child.waitForReport('registry-negative')).resolves.toMatchObject({
      missingRefused: true,
      forgedRefused: true,
      overrideRefused: true,
      missingTreeUntouched: true,
      missingAndForgedCallbacks: 0,
      totalScopeCallbacks: 0,
      baseCallbacks: 0
    })

    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true })
  })

  it('preserves a replaced writer path and retains root capacity after descriptor close failure', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-root-cleanup-build-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    child.sendCommand('registry-cleanup')
    await expect(child.waitForReport('registry-cleanup')).resolves.toMatchObject({
      foreignReplacementPreserved: true,
      closeCapacityRetained: true
    })
    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true })
  })

  it('checks the run after a held profile physical await before creating registry paths', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-root-profile-held-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    child.sendCommand('create-root-physical-held')
    await expect(child.waitForReport('registry-profile-physical-held')).resolves.toMatchObject({
      type: 'registry-profile-physical-held'
    })
    child.sendCommand('change-userdata-resume')
    await expect(child.waitForReport('registry-profile-physical-result')).resolves.toMatchObject({
      created: false,
      gatewayCalls: 0,
      registryPathUntouched: true
    })
    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true })
  })

  it('rechecks the run after a held gateway bind before publishing a root for a retired document', async () => {
    profile = await createQaFixtureProfile()
    fixtureOutput = await mkdtemp(join(tmpdir(), 'metis-qa-root-gateway-retired-'))
    child = startQaRunOwnerChild(await buildQaRunOwnerChild(fixtureOutput), profile.profile.path)
    const hello = JSON.parse((await child.readFrame()).toString('utf8')) as { bootChallenge: string }
    await child.sendFrame(signQaFixtureLaunch(hello.bootChallenge, profile))
    await expect(child.waitForReport('active')).resolves.toMatchObject({ current: true })

    child.sendCommand('create-root-held')
    await expect(child.waitForReport('gateway-held')).resolves.toMatchObject({ type: 'gateway-held' })
    child.sendCommand('retire-window-resume')
    await expect(child.waitForReport('root-held')).resolves.toMatchObject({
      created: false,
      gatewayPublished: false
    })
    child.sendCommand('settle')
    await expect(child.waitForReport('settled')).resolves.toMatchObject({ available: true })
  })
})
