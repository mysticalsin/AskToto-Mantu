import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureRuntimeProfileParentPin,
  describeRuntimeSpeechPackPurposeRoot,
  disposeRuntimeProfileParentPin,
  disposeRuntimeSpeechPackPurposeRoot,
  openRuntimeSpeechPackPurposeRoot
} from '../infra/storage/runtime-purpose-root'
import type { MainSpeechPackRootLease } from './main-speech-pack-root'
import type { ProtectedSpeechPackKeyAnchorLease } from './speech-pack-receipt-key-contract'
import { createMainSpeechPackKeyAnchorOwner } from './speech-pack-key-anchor-owner'

const cleanups: Array<() => Promise<void>> = []
const leases: ProtectedSpeechPackKeyAnchorLease[] = []

async function fixture() {
  const profilePath = await mkdtemp(join(tmpdir(), 'speech-pack-key-owner-'))
  const profile = await captureRuntimeProfileParentPin({
    profilePath,
    binding: {
      profileBinding: 'profile-test',
      principalBinding: 'principal-test',
      persistentProfileGeneration: 'generation-test'
    },
    assertCurrentSync: () => undefined,
    assertProfilePhysicalCurrent: async () => undefined,
    assertSingleInstanceCurrentSync: () => undefined
  })
  const keyPurposeRoot = await openRuntimeSpeechPackPurposeRoot({ parent: profile, mode: 'create-explicit' })
  cleanups.push(async () => {
    await disposeRuntimeSpeechPackPurposeRoot(keyPurposeRoot)
    await disposeRuntimeProfileParentPin(profile)
    await rm(profilePath, { recursive: true, force: true })
  })
  const keyRegistryRoot = Object.freeze({
    bindingId: describeRuntimeSpeechPackPurposeRoot(keyPurposeRoot).bindingId,
    assertCurrent: () => undefined,
    assertPhysicalCurrent: async () => undefined
  })
  const scope = Object.freeze({
    profileNamespace: 'profile-test',
    principalAssociation: 'principal-test',
    profileGeneration: 'generation-test',
    nativeKeyAccess: 'allowed' as const,
    intent: 'explicit-pack-maintenance' as const,
    assertCurrent: () => undefined,
    assertPhysicalCurrent: async () => undefined
  })
  const lease = {
    scope,
    keyRegistryRoot,
    keyPurposeRoot,
    assertCurrentSync: () => undefined,
    assertPhysicalCurrent: async () => undefined
  } as unknown as MainSpeechPackRootLease
  return { profile, lease, scope, keyRegistryRoot }
}

afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.dispose().catch(() => undefined)))
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

describe('main speech-pack key-anchor adapter', () => {
  it('creates and reopens only through the retained runtime candidate and authenticated hook', async () => {
    const owned = await fixture()
    const owner = createMainSpeechPackKeyAnchorOwner(owned.lease)
    const keyId = 'a'.repeat(64)
    const bytes = Buffer.from('bounded protected anchor envelope')

    const created = await owner.createExclusive(owned.scope, owned.keyRegistryRoot, bytes, keyId, 65_536)
    leases.push(created)
    expect(created.bytes.equals(bytes)).toBe(true)
    await created.assertCurrent()
    await created.admitAuthenticated(keyId, bytes)
    await created.assertCurrent()
    await created.dispose()

    const rejected = await owner.openExisting(owned.scope, owned.keyRegistryRoot, 65_536)
    if (!rejected) throw new Error('expected the previously created anchor')
    leases.push(rejected)
    await expect(rejected.admitAuthenticated(keyId, Buffer.from('different bytes'))).rejects.toThrow(
      'SPEECH_PACK_KEY_ANCHOR_AUTHENTICATION_MISMATCH'
    )
    await rejected.dispose()

    const reopened = await owner.openExisting(owned.scope, owned.keyRegistryRoot, 65_536)
    if (!reopened) throw new Error('expected the previously created anchor')
    leases.push(reopened)
    expect(reopened.bytes.equals(bytes)).toBe(true)
    await reopened.admitAuthenticated(keyId, bytes)
    await reopened.assertCurrent()
    await reopened.dispose()
  })

  it('rejects a structurally copied scope before opening the fixed anchor', async () => {
    const owned = await fixture()
    const owner = createMainSpeechPackKeyAnchorOwner(owned.lease)
    await expect(owner.openExisting({ ...owned.scope }, owned.keyRegistryRoot, 65_536)).rejects.toThrow(
      'SPEECH_PACK_KEY_OWNER_SCOPE_MISMATCH'
    )
  })
})
