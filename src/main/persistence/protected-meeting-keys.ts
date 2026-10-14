import { app, safeStorage } from 'electron'
import { constants } from 'node:fs'
import { link, lstat, open, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { MeetingSpeechPersistenceService } from '../infra/process/meeting-speech-host'
import { preparePrivateCurrentUserAcl } from '../win-security'
import { type OpaqueOperationScope, type OwnedMeetingRoot, RootRegistry, type WriterLease } from './root-registry'
import { PROTECTED_KEY_FILE, readProtectedKeyFile } from './protected-key-file'

const ENVELOPE_MARKER = Buffer.from('ATKENC2\n', 'utf8')
const MAX_KEY_RECORD_BYTES = 4096
const MAX_WRAPPED_KEY_BYTES = 2048
const RECORD_PURPOSE = 'metis-protected-meeting-key/v2'
const RECORD_FIELDS = [
  'backend',
  'journalGeneration',
  'journalId',
  'keyId',
  'meetingId',
  'principalAssociation',
  'profileNamespace',
  'purpose',
  'v',
  'wrappedJournalKey'
]
const ENVELOPE_FIELDS = ['ct', 'iv', 'kLocal', 'tag', 'v']
const SCOPE_COMPONENT = /^[A-Za-z0-9_-]{1,128}$/

export type NativeMeetingKeyBackend = 'windows-dpapi' | 'macos-keychain' | 'linux-secret-service'

export interface KeyReference {
  readonly profileNamespace: string
  readonly principalAssociation: string
  readonly meetingId: string
  readonly journalGeneration: string
  readonly journalId: string
  readonly keyId: string
}

export interface ProtectedKeyHandle {
  readonly reference: KeyReference
  readonly keyId: string
  readonly keyBinding: object
  withKey<T>(use: (owned32Bytes: Uint8Array) => T | Promise<T>): Promise<T>
  retire(): void
  dispose(): Promise<void>
}

export interface ProtectedMeetingKeys {
  create(
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    writer: WriterLease,
    journalId: string
  ): Promise<ProtectedKeyHandle>
  open(scope: OpaqueOperationScope, root: OwnedMeetingRoot, reference: KeyReference): Promise<ProtectedKeyHandle>
  withKey<T>(
    scope: OpaqueOperationScope,
    handle: ProtectedKeyHandle,
    use: (owned32Bytes: Uint8Array) => T | Promise<T>
  ): Promise<T>
  retire(handle: ProtectedKeyHandle): void
  settleAndDispose(handle: ProtectedKeyHandle): Promise<void>
}

export interface NativeKeyStore {
  selectedBackend(): NativeMeetingKeyBackend | undefined
  wrap(contentKeyBase64: string): Buffer
  unwrap(wrapped: Buffer): string
}

export interface ProtectedMeetingKeysOptions {
  readonly roots: RootRegistry
  readonly speech: MeetingSpeechPersistenceService
  readonly nativeKeyStore?: NativeKeyStore
  /** Awaited after temp sync and before exclusive publication; must retain the original scope. */
  readonly prepareBeforeReplace?: (
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    tempPath: string
  ) => void | Promise<void>
  readonly maxRecordBytes?: number
}

interface KeyState {
  readonly scope: OpaqueOperationScope
  readonly root: OwnedMeetingRoot
  readonly reference: KeyReference
  readonly key: Uint8Array
  readonly pending: Set<Promise<unknown>>
  readonly keyBinding: object
  retired: boolean
  disposed: boolean
}

interface ProtectedKeyRecord {
  v: 2
  purpose: typeof RECORD_PURPOSE
  profileNamespace: string
  principalAssociation: string
  meetingId: string
  journalGeneration: string
  journalId: string
  keyId: string
  backend: NativeMeetingKeyBackend
  wrappedJournalKey: string
}

const states = new WeakMap<ProtectedKeyHandle, KeyState>()

function exactObjectKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === keys.slice().sort().join(',')
}

function boundedComponent(value: string, label: string): void {
  if (!SCOPE_COMPONENT.test(value)) throw new Error(`Invalid ${label}`)
}

function secureBase64(value: unknown, maxBytes: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('Protected key record is malformed')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) {
    bytes.fill(0)
    throw new Error('Protected key record exceeds its bound')
  }
  return bytes
}

function base64ForKey(bytes: Uint8Array): string {
  if (
    !(bytes instanceof Uint8Array) ||
    Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
    bytes.byteLength !== 32
  ) {
    throw new Error('Native meeting key must be an exact owned 32-byte Uint8Array')
  }
  return Buffer.from(bytes).toString('base64')
}

/** Native Electron safeStorage backend selector. The legacy file-keystore switch is not consulted. */
export function createNativeMeetingKeyStore(): NativeKeyStore {
  const electronStorage = safeStorage as typeof safeStorage & { getSelectedStorageBackend?: () => string }
  const selectedBackend = (): NativeMeetingKeyBackend | undefined => {
    if (!app.isPackaged || !safeStorage.isEncryptionAvailable()) return undefined
    if (process.platform === 'win32') return 'windows-dpapi'
    if (process.platform === 'darwin') return 'macos-keychain'
    if (!electronStorage.getSelectedStorageBackend) return undefined
    const selected = electronStorage.getSelectedStorageBackend()
    if (process.platform === 'linux' && ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(selected))
      return 'linux-secret-service'
    // In particular, Electron's `basic_text` backend is never a production key protector.
    return undefined
  }
  return {
    selectedBackend,
    wrap(contentKeyBase64) {
      if (!selectedBackend()) throw new Error('Native protected-key backend is unavailable')
      return safeStorage.encryptString(contentKeyBase64)
    },
    unwrap(wrapped) {
      if (!selectedBackend()) throw new Error('Native protected-key backend is unavailable')
      return safeStorage.decryptString(wrapped)
    }
  }
}

function copyExactKey(key: Uint8Array): Uint8Array {
  const owned = new Uint8Array(32)
  owned.set(key)
  return owned
}

function zero(bytes: Uint8Array | Buffer): void {
  try {
    if (bytes.byteLength) bytes.fill(0)
  } catch {
    // A transferred source may be detached by the worker after it takes ownership.
  }
}

function keyPath(root: OwnedMeetingRoot): string {
  return join(root.meetingPath, PROTECTED_KEY_FILE)
}

function recordFromPlaintext(text: string): ProtectedKeyRecord {
  if (Buffer.byteLength(text, 'utf8') > 2048) throw new Error('Protected key record is oversized')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('Protected key record is malformed')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Protected key record is malformed')
  const record = value as Record<string, unknown>
  if (
    !exactObjectKeys(record, RECORD_FIELDS) ||
    record.v !== 2 ||
    record.purpose !== RECORD_PURPOSE ||
    !['windows-dpapi', 'macos-keychain', 'linux-secret-service'].includes(String(record.backend)) ||
    typeof record.profileNamespace !== 'string' ||
    typeof record.principalAssociation !== 'string' ||
    typeof record.meetingId !== 'string' ||
    typeof record.journalGeneration !== 'string' ||
    typeof record.journalId !== 'string' ||
    typeof record.keyId !== 'string' ||
    typeof record.wrappedJournalKey !== 'string'
  )
    throw new Error('Protected key record is malformed')
  for (const [value, label] of [
    [record.profileNamespace, 'profile namespace'],
    [record.principalAssociation, 'principal association'],
    [record.meetingId, 'meeting identifier'],
    [record.journalGeneration, 'journal generation'],
    [record.journalId, 'journal identifier'],
    [record.keyId, 'key identifier']
  ] as const)
    boundedComponent(value, label)
  const journalKey = secureBase64(record.wrappedJournalKey, 64)
  if (journalKey.length !== 32) {
    journalKey.fill(0)
    throw new Error('Protected meeting key has an invalid length')
  }
  journalKey.fill(0)
  return record as unknown as ProtectedKeyRecord
}

function decodeEnvelope(bytes: Buffer): { envelopeJson: Uint8Array; kLocal: string } {
  if (
    bytes.byteLength < ENVELOPE_MARKER.byteLength + 32 ||
    bytes.byteLength > MAX_KEY_RECORD_BYTES ||
    !bytes.subarray(0, ENVELOPE_MARKER.length).equals(ENVELOPE_MARKER)
  ) {
    throw new Error('Protected key record is malformed')
  }
  const json = bytes.subarray(ENVELOPE_MARKER.length)
  let parsed: unknown
  try {
    parsed = JSON.parse(json.toString('utf8'))
  } catch {
    throw new Error('Protected key record is malformed')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Protected key record is malformed')
  const envelope = parsed as Record<string, unknown>
  if (
    !exactObjectKeys(envelope, ENVELOPE_FIELDS) ||
    envelope.v !== 2 ||
    typeof envelope.kLocal !== 'string' ||
    !envelope.kLocal.startsWith('S:') ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.kLocal.slice(2)) ||
    typeof envelope.iv !== 'string' ||
    typeof envelope.tag !== 'string' ||
    typeof envelope.ct !== 'string'
  )
    throw new Error('Protected key record is malformed')
  const iv = secureBase64(envelope.iv, 12)
  const tag = secureBase64(envelope.tag, 16)
  const ct = secureBase64(envelope.ct, 2048)
  if (iv.length !== 12 || tag.length !== 16 || ct.length === 0 || json.toString('utf8') !== JSON.stringify(envelope)) {
    iv.fill(0)
    tag.fill(0)
    ct.fill(0)
    throw new Error('Protected key record is malformed')
  }
  iv.fill(0)
  tag.fill(0)
  ct.fill(0)
  const envelopeJson = new Uint8Array(json.byteLength)
  envelopeJson.set(json)
  return { envelopeJson, kLocal: envelope.kLocal }
}

function identityMatches(
  record: ProtectedKeyRecord,
  expected: KeyReference,
  backend: NativeMeetingKeyBackend
): boolean {
  return (
    record.backend === backend &&
    record.profileNamespace === expected.profileNamespace &&
    record.principalAssociation === expected.principalAssociation &&
    record.meetingId === expected.meetingId &&
    record.journalGeneration === expected.journalGeneration &&
    record.journalId === expected.journalId &&
    record.keyId === expected.keyId
  )
}

export function createProtectedMeetingKeys(options: ProtectedMeetingKeysOptions): ProtectedMeetingKeys {
  const native = options.nativeKeyStore ?? createNativeMeetingKeyStore()
  const maxRecordBytes = options.maxRecordBytes ?? MAX_KEY_RECORD_BYTES
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > MAX_KEY_RECORD_BYTES) {
    throw new Error('Invalid protected key-record limit')
  }

  const assertLive = (
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    writer?: WriterLease
  ): NativeMeetingKeyBackend => {
    options.roots.assertScopeCurrent(scope, root)
    root.assertCurrent()
    if (root.nativeKeyAccess === 'explicitly-disabled')
      throw new Error('Native protected-key use was explicitly disabled for this isolated operation')
    if (writer) {
      if (writer.root !== root) throw new Error('Writer lease belongs to another persistence root')
      writer.assertCurrent()
    }
    const backend = native.selectedBackend()
    root.assertCurrent()
    if (writer) writer.assertCurrent()
    if (!backend) throw new Error('Native protected-key backend unavailable; existing records were preserved')
    return backend
  }

  const assertPhysicalLive = async (
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    writer?: WriterLease
  ): Promise<void> => {
    options.roots.assertScopeCurrent(scope, root)
    root.assertCurrent()
    await root.assertPhysicalCurrent()
    if (writer) await writer.assertPhysicalCurrent()
    root.assertCurrent()
    if (writer) writer.assertCurrent()
  }

  const decodeRecord = async (
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    expected: KeyReference
  ): Promise<Uint8Array> => {
    const backend = assertLive(scope, root)
    const bytes = await readProtectedKeyFile(options.roots, scope, root, maxRecordBytes)
    let contentKey: Buffer | undefined
    let envelope: ReturnType<typeof decodeEnvelope> | undefined
    try {
      envelope = decodeEnvelope(bytes)
      root.assertCurrent()
      const wrappedContentKey = secureBase64(envelope.kLocal.slice(2), MAX_WRAPPED_KEY_BYTES)
      let decodedContentKey = ''
      try {
        decodedContentKey = native.unwrap(wrappedContentKey)
      } finally {
        wrappedContentKey.fill(0)
      }
      root.assertCurrent()
      await root.assertPhysicalCurrent()
      options.roots.assertScopeCurrent(scope, root)
      if (native.selectedBackend() !== backend) throw new Error('Native key backend changed during protected-key read')
      contentKey = secureBase64(decodedContentKey, 32)
      decodedContentKey = ''
      if (contentKey.byteLength !== 32)
        throw new Error('Protected key record is locked or invalid; original bytes were preserved')
      const workerKey = new Uint8Array(32)
      workerKey.set(contentKey)
      let plaintext: string
      try {
        plaintext = await options.speech.decryptEnvelopeV2(envelope.envelopeJson, workerKey, envelope.kLocal)
      } finally {
        zero(workerKey)
      }
      root.assertCurrent()
      await root.assertPhysicalCurrent()
      options.roots.assertScopeCurrent(scope, root)
      if (native.selectedBackend() !== backend) throw new Error('Native key backend changed during protected-key read')
      const finalBytes = await readProtectedKeyFile(options.roots, scope, root, maxRecordBytes)
      try {
        if (!finalBytes.equals(bytes))
          throw new Error(
            'Protected key record changed during native or worker processing; original bytes were preserved'
          )
      } finally {
        finalBytes.fill(0)
      }
      const record = recordFromPlaintext(plaintext)
      const journalKey = secureBase64(record.wrappedJournalKey, 64)
      try {
        if (journalKey.length !== 32 || !identityMatches(record, expected, backend)) {
          throw new Error('Protected key association does not match this profile; original bytes were preserved')
        }
        const result = new Uint8Array(32)
        result.set(journalKey)
        return result
      } finally {
        journalKey.fill(0)
      }
    } finally {
      bytes.fill(0)
      if (contentKey) contentKey.fill(0)
      if (envelope) envelope.envelopeJson.fill(0)
    }
  }

  const publish = async (
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    writer: WriterLease,
    bytes: Buffer
  ): Promise<void> => {
    if (bytes.byteLength > maxRecordBytes) throw new Error('Protected key record exceeds its bound')
    assertLive(scope, root, writer)
    const destination = keyPath(root)
    const temporary = join(root.meetingPath, `.meeting-key-${randomBytes(12).toString('hex')}.tmp`)
    let tempFile: FileHandle | undefined
    let tempIdentity:
      | { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeNs: number | bigint }
      | undefined
    try {
      tempFile = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600
      )
      const createdTemp = await tempFile.stat({ bigint: true })
      if (!createdTemp.isFile() || createdTemp.size !== 0n) throw new Error('Protected key temp was not created empty')
      tempIdentity = {
        dev: createdTemp.dev,
        ino: createdTemp.ino,
        size: createdTemp.size,
        mtimeNs: createdTemp.mtimeNs
      }
      options.roots.secureOwnedPath(scope, root, temporary)
      if (process.platform === 'win32' && !(await preparePrivateCurrentUserAcl(temporary)))
        throw new Error('Protected key temp Windows ACL is not private to the current process owner')
      assertLive(scope, root, writer)
      await assertPhysicalLive(scope, root, writer)
      const [namedPreparedTemp, heldPreparedTemp] = await Promise.all([
        lstat(temporary, { bigint: true }),
        tempFile.stat({ bigint: true })
      ])
      if (
        !namedPreparedTemp.isFile() ||
        namedPreparedTemp.isSymbolicLink() ||
        namedPreparedTemp.nlink !== 1n ||
        namedPreparedTemp.dev !== tempIdentity.dev ||
        namedPreparedTemp.ino !== tempIdentity.ino ||
        namedPreparedTemp.size !== 0n ||
        heldPreparedTemp.dev !== tempIdentity.dev ||
        heldPreparedTemp.ino !== tempIdentity.ino ||
        heldPreparedTemp.size !== 0n
      ) {
        throw new Error('Protected key temp physical version changed during ACL preparation')
      }
      await tempFile.writeFile(bytes)
      await tempFile.sync()
      const written = await tempFile.stat({ bigint: true })
      if (!written.isFile() || written.size !== BigInt(bytes.byteLength))
        throw new Error('Protected key temp write was incomplete')
      tempIdentity = { dev: written.dev, ino: written.ino, size: written.size, mtimeNs: written.mtimeNs }
      await options.roots.syncDirectory(scope, root)
      await options.prepareBeforeReplace?.(scope, root, temporary)
      assertLive(scope, root, writer)
      await assertPhysicalLive(scope, root, writer)
      const [namedTemp, heldTemp] = await Promise.all([
        lstat(temporary, { bigint: true }),
        tempFile.stat({ bigint: true })
      ])
      if (
        namedTemp.isSymbolicLink() ||
        !namedTemp.isFile() ||
        namedTemp.dev !== tempIdentity.dev ||
        namedTemp.ino !== tempIdentity.ino ||
        namedTemp.size !== tempIdentity.size ||
        heldTemp.dev !== tempIdentity.dev ||
        heldTemp.ino !== tempIdentity.ino ||
        heldTemp.size !== tempIdentity.size ||
        heldTemp.mtimeNs !== tempIdentity.mtimeNs ||
        namedTemp.mtimeNs !== tempIdentity.mtimeNs
      )
        throw new Error('Protected key temp physical version changed after preparation')
      assertLive(scope, root, writer)
      await link(temporary, destination)
      const final = await lstat(destination, { bigint: true })
      if (
        final.isSymbolicLink() ||
        !final.isFile() ||
        final.dev !== tempIdentity.dev ||
        final.ino !== tempIdentity.ino
      ) {
        throw new Error('Protected key publication physical version mismatch')
      }
      await unlink(temporary)
      await options.roots.syncDirectory(scope, root)
      assertLive(scope, root, writer)
      await assertPhysicalLive(scope, root, writer)
      const readback = await readProtectedKeyFile(options.roots, scope, root, maxRecordBytes)
      try {
        if (!readback.equals(bytes)) throw new Error('Protected key record readback did not match publication')
        const finalReadback = await lstat(destination, { bigint: true })
        if (
          finalReadback.isSymbolicLink() ||
          finalReadback.nlink !== 1n ||
          finalReadback.dev !== tempIdentity.dev ||
          finalReadback.ino !== tempIdentity.ino
        ) {
          throw new Error('Protected key final file identity changed after readback')
        }
      } finally {
        readback.fill(0)
      }
    } catch (error) {
      throw error
    } finally {
      if (tempFile) await tempFile.close().catch(() => undefined)
      if (tempIdentity) {
        try {
          const current = await lstat(temporary, { bigint: true })
          if (
            current.isFile() &&
            !current.isSymbolicLink() &&
            current.dev === tempIdentity.dev &&
            current.ino === tempIdentity.ino
          )
            await unlink(temporary)
        } catch {
          // A missing/replaced temp is left to bounded owned-generation recovery.
        }
      }
    }
  }

  const retireHandle = (handle: ProtectedKeyHandle): void => {
    const state = states.get(handle)
    if (state) state.retired = true
  }

  const disposeHandle = async (handle: ProtectedKeyHandle): Promise<void> => {
    const state = states.get(handle)
    if (!state || state.disposed) return
    state.retired = true
    await Promise.allSettled([...state.pending])
    state.key.fill(0)
    state.disposed = true
    states.delete(handle)
  }

  const withKeyInternal = async <T>(
    scope: OpaqueOperationScope,
    handle: ProtectedKeyHandle,
    use: (owned32Bytes: Uint8Array) => T | Promise<T>
  ): Promise<T> => {
    const state = states.get(handle)
    if (!state || state.scope !== scope || state.keyBinding !== handle.keyBinding || state.retired || state.disposed) {
      throw new Error('Protected meeting key is retired')
    }
    if (typeof use !== 'function') throw new Error('Protected key callback is required')
    options.roots.assertScopeCurrent(scope, state.root)
    state.root.assertCurrent()
    await assertPhysicalLive(scope, state.root)
    if (state.retired || state.disposed) throw new Error('Protected meeting key is retired')
    const owned32Bytes = copyExactKey(state.key)
    const work = Promise.resolve().then(() => {
      if (state.retired || state.disposed) throw new Error('Protected meeting key is retired')
      return use(owned32Bytes)
    })
    state.pending.add(work)
    try {
      const result = await work
      options.roots.assertScopeCurrent(scope, state.root)
      await assertPhysicalLive(scope, state.root)
      if (state.retired || state.disposed) throw new Error('Protected meeting key was retired during use')
      return result
    } finally {
      owned32Bytes.fill(0)
      state.pending.delete(work)
    }
  }

  const makeHandle = (
    scope: OpaqueOperationScope,
    root: OwnedMeetingRoot,
    reference: KeyReference,
    key: Uint8Array
  ): ProtectedKeyHandle => {
    const ownedReference = Object.freeze({ ...reference })
    const keyBinding = Object.freeze({})
    let handle: ProtectedKeyHandle
    handle = Object.freeze({
      reference: ownedReference,
      keyId: ownedReference.keyId,
      keyBinding,
      withKey: <T>(use: (owned32Bytes: Uint8Array) => T | Promise<T>) => withKeyInternal(scope, handle, use),
      retire: () => retireHandle(handle),
      dispose: () => disposeHandle(handle)
    })
    states.set(handle, {
      scope,
      root,
      reference: ownedReference,
      key,
      pending: new Set(),
      keyBinding,
      retired: false,
      disposed: false
    })
    return handle
  }

  const service: ProtectedMeetingKeys = {
    async create(scope, root, writer, journalId) {
      boundedComponent(journalId, 'journal identifier')
      if (writer.root !== root) throw new Error('Writer lease belongs to another persistence root')
      const backend = assertLive(scope, root, writer)
      const key = new Uint8Array(randomBytes(32))
      const contentKey = new Uint8Array(randomBytes(32))
      const iv = new Uint8Array(randomBytes(12))
      let wrapped: Buffer | undefined
      let envelope: Buffer | undefined
      let contentKeyBase64 = ''
      let journalKeyBase64 = ''
      const reference: KeyReference = Object.freeze({
        profileNamespace: root.profileNamespace,
        principalAssociation: root.principalAssociation,
        meetingId: root.meetingId,
        journalGeneration: root.ownerGeneration,
        journalId,
        keyId: randomBytes(16).toString('hex')
      })
      try {
        journalKeyBase64 = base64ForKey(key)
        contentKeyBase64 = base64ForKey(contentKey)
        const record: ProtectedKeyRecord = {
          v: 2,
          purpose: RECORD_PURPOSE,
          profileNamespace: reference.profileNamespace,
          principalAssociation: reference.principalAssociation,
          meetingId: reference.meetingId,
          journalGeneration: reference.journalGeneration,
          journalId: reference.journalId,
          keyId: reference.keyId,
          backend,
          wrappedJournalKey: journalKeyBase64
        }
        const plaintext = JSON.stringify(record)
        if (Buffer.byteLength(plaintext, 'utf8') > 2048)
          throw new Error('Protected key identity record exceeds its bound')
        assertLive(scope, root, writer)
        await assertPhysicalLive(scope, root, writer)
        wrapped = native.wrap(contentKeyBase64)
        assertLive(scope, root, writer)
        if (
          native.selectedBackend() !== backend ||
          wrapped.byteLength === 0 ||
          wrapped.byteLength > MAX_WRAPPED_KEY_BYTES
        ) {
          throw new Error('Native protected-key wrapping failed; no journal was created')
        }
        const kLocal = `S:${wrapped.toString('base64')}`
        const workerContentKey = new Uint8Array(32)
        const workerIv = new Uint8Array(12)
        workerContentKey.set(contentKey)
        workerIv.set(iv)
        try {
          envelope = await options.speech.encryptEnvelopeV2(plaintext, workerContentKey, workerIv, kLocal)
        } finally {
          zero(workerContentKey)
          zero(workerIv)
        }
        assertLive(scope, root, writer)
        await assertPhysicalLive(scope, root, writer)
        if (
          native.selectedBackend() !== backend ||
          envelope.byteLength > maxRecordBytes ||
          !envelope.subarray(0, ENVELOPE_MARKER.length).equals(ENVELOPE_MARKER)
        ) {
          throw new Error('Protected key v2 envelope is unavailable or oversized')
        }
        await publish(scope, root, writer, envelope)
        const opened = await decodeRecord(scope, root, reference)
        try {
          if (!Buffer.from(opened).equals(Buffer.from(key))) throw new Error('Protected key readback validation failed')
        } finally {
          opened.fill(0)
        }
        assertLive(scope, root, writer)
        return makeHandle(scope, root, reference, key)
      } catch (error) {
        key.fill(0)
        throw error
      } finally {
        zero(contentKey)
        zero(iv)
        if (wrapped) wrapped.fill(0)
        if (envelope) envelope.fill(0)
        contentKeyBase64 = ''
        journalKeyBase64 = ''
      }
    },

    async open(scope, root, reference) {
      options.roots.assertScopeCurrent(scope, root)
      root.assertCurrent()
      if (
        !reference ||
        !exactObjectKeys(reference as unknown as Record<string, unknown>, [
          'profileNamespace',
          'principalAssociation',
          'meetingId',
          'journalGeneration',
          'journalId',
          'keyId'
        ])
      ) {
        throw new Error('Invalid protected key reference')
      }
      for (const [value, label] of [
        [reference.profileNamespace, 'profile namespace'],
        [reference.principalAssociation, 'principal association'],
        [reference.meetingId, 'meeting identifier'],
        [reference.journalGeneration, 'journal generation'],
        [reference.journalId, 'journal identifier'],
        [reference.keyId, 'key identifier']
      ] as const)
        boundedComponent(value, label)
      if (
        reference.profileNamespace !== root.profileNamespace ||
        reference.principalAssociation !== root.principalAssociation ||
        reference.meetingId !== root.meetingId ||
        reference.journalGeneration !== root.ownerGeneration
      )
        throw new Error('Protected key reference belongs to another persistence owner')
      const key = await decodeRecord(scope, root, reference)
      try {
        root.assertCurrent()
        return makeHandle(scope, root, reference, key)
      } catch (error) {
        key.fill(0)
        throw error
      }
    },

    async withKey<T>(
      scope: OpaqueOperationScope,
      handle: ProtectedKeyHandle,
      use: (owned32Bytes: Uint8Array) => T | Promise<T>
    ) {
      const state = states.get(handle)
      if (!state || state.scope !== scope || state.retired || state.disposed)
        throw new Error('Protected meeting key is retired')
      return withKeyInternal(scope, handle, use)
    },

    retire(handle) {
      retireHandle(handle)
    },

    async settleAndDispose(handle) {
      await disposeHandle(handle)
    }
  }
  return service
}
