import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { link, lstat, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RootRegistry, type RootScopeBinding } from './root-registry'
import { createProtectedMeetingKeys, type NativeKeyStore } from './protected-meeting-keys'
import type { MeetingSpeechPersistenceService } from '../infra/process/meeting-speech-host'

const aclHarness = vi.hoisted(() => ({
  prepare: null as ((path: string) => Promise<boolean>) | null,
  verify: null as ((path: string) => Promise<boolean>) | null
}))
vi.mock('../win-security', () => ({
  preparePrivateCurrentUserAcl: (path: string) => aclHarness.prepare?.(path) ?? Promise.resolve(true),
  verifyPrivateCurrentUserAcl: (path: string) => aclHarness.verify?.(path) ?? Promise.resolve(true)
}))

const marker = Buffer.from('ATKENC2\n')
const mockNativeMaster = Buffer.alloc(32, 0x71)
const REAL_PLATFORM = process.platform

function authority(generation: string, scopes = new WeakMap<object, RootScopeBinding>()) {
  let active = true
  const scope = Object.freeze({})
  const binding: RootScopeBinding = Object.freeze({
    profileNamespace: 'profile-test',
    principalAssociation: 'principal-test',
    generation,
    nativeKeyAccess: 'allowed',
    legacyFileKeyAccess: 'denied',
    maxHeldRoots: 4,
    isCurrent: () => active
  })
  scopes.set(scope, binding)
  return {
    scope,
    scopes,
    retire: () => {
      active = false
    }
  }
}

function testNativeKeyStore(): NativeKeyStore {
  const wrap = (contentKeyBase64: string): Buffer => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', mockNativeMaster, iv)
    const ciphertext = Buffer.concat([cipher.update(contentKeyBase64, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
  }
  const unwrap = (wrapped: Buffer): string => {
    if (wrapped.byteLength < 28) throw new Error('test key locked')
    const decipher = createDecipheriv('aes-256-gcm', mockNativeMaster, wrapped.subarray(0, 12))
    decipher.setAuthTag(wrapped.subarray(12, 28))
    return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()]).toString('utf8')
  }
  return { selectedBackend: () => 'macos-keychain', wrap, unwrap }
}

function testSpeechService(holdFirstEncryption?: {
  started(): void
  wait: Promise<void>
}): MeetingSpeechPersistenceService {
  let held = false
  const service = {
    async encryptEnvelopeV2(content: string, contentKey: Uint8Array, iv: Uint8Array, kLocal: string) {
      if (holdFirstEncryption && !held) {
        held = true
        holdFirstEncryption.started()
        await holdFirstEncryption.wait
      }
      const cipher = createCipheriv('aes-256-gcm', contentKey, iv)
      const ciphertext = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()])
      const json = Buffer.from(
        JSON.stringify({
          v: 2,
          iv: Buffer.from(iv).toString('base64'),
          tag: cipher.getAuthTag().toString('base64'),
          ct: ciphertext.toString('base64'),
          kLocal
        })
      )
      return Buffer.concat([marker, json])
    },
    async decryptEnvelopeV2(envelopeJson: Uint8Array, contentKey: Uint8Array, kLocal: string) {
      const envelope = JSON.parse(Buffer.from(envelopeJson).toString('utf8')) as {
        v: number
        iv: string
        tag: string
        ct: string
        kLocal: string
      }
      if (envelope.v !== 2 || envelope.kLocal !== kLocal) throw new Error('test v2 envelope invalid')
      const decipher = createDecipheriv('aes-256-gcm', contentKey, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]).toString('utf8')
    }
  }
  return service as unknown as MeetingSpeechPersistenceService
}

describe('protected meeting-key lifecycle', () => {
  let base: string | undefined

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
    aclHarness.prepare = null
    aclHarness.verify = null
    mockNativeMaster.fill(0x71)
    if (base) await rm(base, { recursive: true, force: true })
    base = undefined
  })

  it('retires a held key publication permanently, then admits a live successor', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-key-race-'))
    let release!: () => void
    let markStarted!: () => void
    const held = {
      started: () => markStarted(),
      wait: new Promise<void>((resolve) => {
        release = resolve
      })
    }
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const oldOwner = authority('generation-one')
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => oldOwner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    const keyService = createProtectedMeetingKeys({
      roots,
      nativeKeyStore: testNativeKeyStore(),
      speech: testSpeechService(held)
    })
    const root = await roots.create(oldOwner.scope, 'meeting-race')
    const writer = await roots.acquireWriter(oldOwner.scope, root)
    const pending = keyService.create(oldOwner.scope, root, writer, 'journal-race')
    await started

    roots.retireScope(oldOwner.scope)
    oldOwner.retire()
    release()
    await expect(pending).rejects.toThrow(/retired/i)
    await writer.release()
    await expect(lstat(join(root.meetingPath, 'meeting-key.v2'))).rejects.toMatchObject({ code: 'ENOENT' })

    const successor = authority('generation-two', oldOwner.scopes)
    const successorRoot = await roots.openExisting(successor.scope, 'meeting-race')
    const successorWriter = await roots.acquireWriter(successor.scope, successorRoot)
    const recovered = await keyService.create(successor.scope, successorRoot, successorWriter, 'journal-race')
    const supplied: Uint8Array[] = []
    const byteLength = await recovered.withKey((owned) => {
      supplied.push(owned)
      expect(Object.getPrototypeOf(owned)).toBe(Uint8Array.prototype)
      expect(owned.byteLength).toBe(32)
      return owned.byteLength
    })
    expect(byteLength).toBe(32)
    expect([...supplied[0]]).toEqual(Array.from({ length: 32 }, () => 0))

    const reopened = await keyService.open(successor.scope, successorRoot, recovered.reference)
    await expect(reopened.withKey((owned) => owned.byteLength)).resolves.toBe(32)
    await reopened.dispose()
    await recovered.dispose()
    await successorWriter.release()
  })

  it('reopen is read-only and a corrupt key record is preserved', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-key-readonly-'))
    const owner = authority('generation-one')
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    const missingRoot = await roots.create(owner.scope, 'meeting-no-key')
    const keyService = createProtectedMeetingKeys({
      roots,
      nativeKeyStore: testNativeKeyStore(),
      speech: testSpeechService()
    })
    const missingRef = {
      profileNamespace: missingRoot.profileNamespace,
      principalAssociation: missingRoot.principalAssociation,
      meetingId: missingRoot.meetingId,
      journalGeneration: missingRoot.ownerGeneration,
      journalId: 'journal-missing',
      keyId: 'key-missing'
    }
    await expect(keyService.open(owner.scope, missingRoot, missingRef)).rejects.toThrow()
    await expect(lstat(join(missingRoot.meetingPath, 'meeting-key.v2'))).rejects.toMatchObject({ code: 'ENOENT' })
    const foreignScope = Object.freeze({})
    await expect(keyService.open(foreignScope, missingRoot, missingRef)).rejects.toThrow(/capability unavailable/i)

    const writer = await roots.acquireWriter(owner.scope, missingRoot)
    const handle = await keyService.create(owner.scope, missingRoot, writer, 'journal-existing')
    const path = join(missingRoot.meetingPath, 'meeting-key.v2')
    const alias = join(base, 'outside-key-alias')
    await link(path, alias)
    await expect(keyService.open(owner.scope, missingRoot, handle.reference)).rejects.toThrow(/unavailable or invalid/i)
    await unlink(alias)
    const corrupted = Buffer.from('invalid-but-preserved')
    await writeFile(path, corrupted)
    await expect(keyService.open(owner.scope, missingRoot, handle.reference)).rejects.toThrow()
    await expect(readFile(path)).resolves.toEqual(corrupted)
    await handle.dispose()
    await writer.release()
  })

  it('fails closed when the native backend becomes unavailable and preserves the valid key record', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-key-native-unavailable-'))
    const owner = authority('generation-one')
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    let enabled = true
    const delegate = testNativeKeyStore()
    const native: NativeKeyStore = {
      selectedBackend: () => (enabled ? delegate.selectedBackend() : undefined),
      wrap: (value) => delegate.wrap(value),
      unwrap: (value) => delegate.unwrap(value)
    }
    const service = createProtectedMeetingKeys({ roots, nativeKeyStore: native, speech: testSpeechService() })
    const root = await roots.create(owner.scope, 'meeting-native-unavailable')
    const writer = await roots.acquireWriter(owner.scope, root)
    const created = await service.create(owner.scope, root, writer, 'journal-native-unavailable')
    const path = join(root.meetingPath, 'meeting-key.v2')
    const before = await readFile(path)

    enabled = false
    await expect(service.open(owner.scope, root, created.reference)).rejects.toThrow(/backend unavailable/i)
    await expect(readFile(path)).resolves.toEqual(before)
    before.fill(0)
    await created.dispose()
    await writer.release()
  })

  it('does not publish a key or unlink a replacement after a held ACL proof', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-key-acl-replacement-'))
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    let release!: () => void
    let markStarted!: (path: string) => void
    const started = new Promise<string>((resolve) => {
      markStarted = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    aclHarness.prepare = async (path) => {
      if (!path.endsWith('.tmp')) return true
      markStarted(path)
      await held
      return true
    }
    const owner = authority('generation-one')
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    const service = createProtectedMeetingKeys({
      roots,
      nativeKeyStore: testNativeKeyStore(),
      speech: testSpeechService()
    })
    const root = await roots.create(owner.scope, 'meeting-acl-replacement')
    const writer = await roots.acquireWriter(owner.scope, root)
    const pending = service.create(owner.scope, root, writer, 'journal-acl-replacement')
    const temporary = await started
    await unlink(temporary)
    const replacement = Buffer.from('foreign replacement')
    await writeFile(temporary, replacement)
    release()
    await expect(pending).rejects.toThrow(/temp physical version changed/i)
    await expect(lstat(join(root.meetingPath, 'meeting-key.v2'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(temporary)).resolves.toEqual(replacement)
    replacement.fill(0)
    await writer.release()
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  })

  it('retires the original scope during a held ACL proof before any key bytes are written', async () => {
    base = await mkdtemp(join(tmpdir(), 'metis-key-acl-retirement-'))
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    let release!: () => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    aclHarness.prepare = async (path) => {
      if (!path.endsWith('.tmp')) return true
      markStarted()
      await held
      return true
    }
    const owner = authority('generation-one')
    const roots = new RootRegistry({
      userDataRoot: () => base!,
      resolveScope: (scope) => owner.scopes.get(scope),
      bindGatewayRoot: async () => undefined
    })
    const service = createProtectedMeetingKeys({
      roots,
      nativeKeyStore: testNativeKeyStore(),
      speech: testSpeechService()
    })
    const root = await roots.create(owner.scope, 'meeting-acl-retirement')
    const writer = await roots.acquireWriter(owner.scope, root)
    const pending = service.create(owner.scope, root, writer, 'journal-acl-retirement')
    await started
    roots.retireScope(owner.scope)
    owner.retire()
    release()
    await expect(pending).rejects.toThrow(/retired/i)
    await expect(lstat(join(root.meetingPath, 'meeting-key.v2'))).rejects.toMatchObject({ code: 'ENOENT' })
    const leftovers = await import('node:fs/promises').then(({ readdir }) => readdir(root.meetingPath))
    expect(leftovers.some((name) => name.startsWith('.meeting-key-'))).toBe(false)
    await writer.release()
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true })
  })
})
