import { randomBytes } from 'node:crypto'
import type { MeetingSpeechPersistenceService } from '../infra/process/meeting-speech-host'
import { createNativeMeetingKeyStore, type NativeKeyStore } from './protected-meeting-keys'
import type {
  ProtectedSpeechPackKeyAnchorLease,
  ProtectedSpeechPackKeyAnchorOwner,
  ProtectedSpeechPackReceiptKeys,
  SpeechPackReceiptKeyAnchorRecord,
  SpeechPackReceiptKeyHandle,
  SpeechPackReceiptKeyScope,
  SpeechPackReceiptKeyUse,
  SpeechPackReceiptRegistryRoot
} from './speech-pack-receipt-key-contract'

const MAGIC = Buffer.from('ATKENC2\n', 'utf8')
const PURPOSE = 'metis-speech-pack-owner-key/v1'
const MAX_ANCHOR_BYTES = 65_536
const MAX_PLAINTEXT_BYTES = 49_152
const MAX_WRAPPED_KEY_BYTES = 2_048
// Proposed engineering ceilings. Product qualification must measure and review these before admission.
const MAX_ACTIVE_KEY_USES = 1
const MAX_OPERATIONS_PER_KEY_USE = 4
const ID_PART = /^[A-Za-z0-9_-]{1,128}$/
const ANCHOR_KEYS = ['ct', 'iv', 'kLocal', 'tag', 'v']
const RECORD_KEYS = [
  'backend',
  'keyId',
  'principalAssociation',
  'profileGeneration',
  'profileNamespace',
  'purpose',
  'registryRootBinding',
  'v'
]
const BACKENDS = ['windows-dpapi', 'macos-keychain', 'linux-secret-service'] as const

export interface ProtectedSpeechPackReceiptKeysOptions {
  readonly anchorOwner: ProtectedSpeechPackKeyAnchorOwner
  readonly speech: Pick<MeetingSpeechPersistenceService, 'encryptEnvelopeV2' | 'decryptEnvelopeV2' | 'readLimitBytes'>
  readonly nativeKeyStore?: NativeKeyStore
  /** Hard cap only; actual speech-worker limits remain authoritative when lower. */
  readonly maxPlaintextBytes?: number
  readonly maxAnchorBytes?: number
}

interface AnchorEnvelope {
  readonly bytes: Buffer
  readonly json: Uint8Array
  readonly kLocal: string
}

interface KeyState {
  readonly scope: SpeechPackReceiptKeyScope
  readonly registryRoot: SpeechPackReceiptRegistryRoot
  readonly lease: ProtectedSpeechPackKeyAnchorLease
  readonly key: Uint8Array
  readonly keyId: string
  readonly expectedKLocal: string
  readonly pending: Set<Promise<unknown>>
  activeUses: number
  retired: boolean
  disposed: boolean
}

const handleStates = new WeakMap<SpeechPackReceiptKeyHandle, KeyState>()

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && ID_PART.test(value)
}

function assertIdentity(scope: SpeechPackReceiptKeyScope, registryRoot: SpeechPackReceiptRegistryRoot): void {
  if (
    !validId(scope.profileNamespace) ||
    !validId(scope.principalAssociation) ||
    !validId(scope.profileGeneration) ||
    !/^[a-f0-9]{64}$/.test(registryRoot.bindingId)
  ) {
    throw new Error('SPEECH_PACK_KEY_BINDING_INVALID')
  }
  if (scope.intent !== 'explicit-pack-maintenance') throw new Error('SPEECH_PACK_KEY_EXPLICIT_INTENT_REQUIRED')
  if (scope.nativeKeyAccess !== 'allowed') throw new Error('SPEECH_PACK_KEY_NATIVE_ACCESS_DISABLED')
}

function assertCurrent(scope: SpeechPackReceiptKeyScope, registryRoot: SpeechPackReceiptRegistryRoot): void {
  assertIdentity(scope, registryRoot)
  scope.assertCurrent()
  registryRoot.assertCurrent()
}

async function assertPhysicalCurrent(
  scope: SpeechPackReceiptKeyScope,
  registryRoot: SpeechPackReceiptRegistryRoot
): Promise<void> {
  assertCurrent(scope, registryRoot)
  await Promise.all([scope.assertPhysicalCurrent(), registryRoot.assertPhysicalCurrent()])
  assertCurrent(scope, registryRoot)
}

function strictBase64(value: unknown, maxBytes: number): Buffer {
  if (
    typeof value !== 'string' ||
    value.length > Math.ceil(maxBytes / 3) * 4 + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) {
    bytes.fill(0)
    throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
  }
  return bytes
}

function decodeEnvelope(bytes: Uint8Array, maxBytes: number): AnchorEnvelope {
  if (
    !(bytes instanceof Uint8Array) ||
    (Object.getPrototypeOf(bytes) !== Uint8Array.prototype && !Buffer.isBuffer(bytes)) ||
    bytes.byteLength < MAGIC.byteLength + 1 ||
    bytes.byteLength > maxBytes
  )
    throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
  const owned = Buffer.from(bytes)
  let json: Uint8Array | undefined
  let wrapped: Buffer | undefined
  let iv: Buffer | undefined
  let tag: Buffer | undefined
  let ciphertext: Buffer | undefined
  let transferred = false
  try {
    if (!owned.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
    const jsonBuffer = owned.subarray(MAGIC.length)
    const text = jsonBuffer.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(jsonBuffer)) throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
    const envelope = parsed as Record<string, unknown>
    if (
      !exactKeys(envelope, ANCHOR_KEYS) ||
      envelope.v !== 2 ||
      typeof envelope.kLocal !== 'string' ||
      !envelope.kLocal.startsWith('S:') ||
      typeof envelope.iv !== 'string' ||
      typeof envelope.tag !== 'string' ||
      typeof envelope.ct !== 'string' ||
      JSON.stringify(envelope) !== text
    )
      throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
    wrapped = strictBase64(envelope.kLocal.slice(2), MAX_WRAPPED_KEY_BYTES)
    iv = strictBase64(envelope.iv, 12)
    tag = strictBase64(envelope.tag, 16)
    ciphertext = strictBase64(envelope.ct, maxBytes)
    if (wrapped.length === 0 || iv.length !== 12 || tag.length !== 16)
      throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
    json = new Uint8Array(jsonBuffer.byteLength)
    json.set(jsonBuffer)
    transferred = true
    return { bytes: owned, json, kLocal: envelope.kLocal }
  } catch (error) {
    zero(owned)
    if (json) zero(json)
    throw error
  } finally {
    if (wrapped) zero(wrapped)
    if (iv) zero(iv)
    if (tag) zero(tag)
    if (ciphertext) zero(ciphertext)
    if (!transferred) zero(owned)
  }
}

function parseRecord(text: string): SpeechPackReceiptKeyAnchorRecord {
  if (Buffer.byteLength(text, 'utf8') > MAX_PLAINTEXT_BYTES) throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
  const record = parsed as Record<string, unknown>
  if (
    !exactKeys(record, RECORD_KEYS) ||
    record.v !== 1 ||
    record.purpose !== PURPOSE ||
    !validId(record.profileNamespace) ||
    !validId(record.principalAssociation) ||
    !validId(record.profileGeneration) ||
    !/^[a-f0-9]{64}$/.test(String(record.registryRootBinding)) ||
    !validId(record.keyId) ||
    !BACKENDS.includes(record.backend as (typeof BACKENDS)[number]) ||
    JSON.stringify(record) !== text
  )
    throw new Error('SPEECH_PACK_KEY_ANCHOR_MALFORMED')
  return record as unknown as SpeechPackReceiptKeyAnchorRecord
}

function matches(
  record: SpeechPackReceiptKeyAnchorRecord,
  scope: SpeechPackReceiptKeyScope,
  registryRoot: SpeechPackReceiptRegistryRoot,
  backend: string
): boolean {
  return (
    record.purpose === PURPOSE &&
    record.profileNamespace === scope.profileNamespace &&
    record.principalAssociation === scope.principalAssociation &&
    record.profileGeneration === scope.profileGeneration &&
    record.registryRootBinding === registryRoot.bindingId &&
    record.backend === backend
  )
}

function zero(bytes: Uint8Array | Buffer): void {
  try {
    bytes.fill(0)
  } catch {
    // A worker transfer may detach its owned copy.
  }
}

function copyKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new Error('SPEECH_PACK_KEY_LENGTH_INVALID')
  const copy = new Uint8Array(32)
  copy.set(key)
  return copy
}

function makeRecord(
  scope: SpeechPackReceiptKeyScope,
  registryRoot: SpeechPackReceiptRegistryRoot,
  keyId: string,
  backend: (typeof BACKENDS)[number]
): SpeechPackReceiptKeyAnchorRecord {
  return Object.freeze({
    v: 1,
    purpose: PURPOSE,
    profileNamespace: scope.profileNamespace,
    principalAssociation: scope.principalAssociation,
    profileGeneration: scope.profileGeneration,
    registryRootBinding: registryRoot.bindingId,
    keyId,
    backend
  })
}

export function createProtectedSpeechPackReceiptKeys(
  options: ProtectedSpeechPackReceiptKeysOptions
): ProtectedSpeechPackReceiptKeys {
  const native = options.nativeKeyStore ?? createNativeMeetingKeyStore()
  const maxAnchorBytes = options.maxAnchorBytes ?? MAX_ANCHOR_BYTES
  const maxPlaintextBytes = options.maxPlaintextBytes ?? MAX_PLAINTEXT_BYTES
  if (!Number.isSafeInteger(maxAnchorBytes) || maxAnchorBytes < 1024 || maxAnchorBytes > MAX_ANCHOR_BYTES)
    throw new Error('SPEECH_PACK_KEY_ANCHOR_BOUND_INVALID')
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1024 || maxPlaintextBytes > MAX_PLAINTEXT_BYTES)
    throw new Error('SPEECH_PACK_KEY_PLAINTEXT_BOUND_INVALID')

  const effectivePlaintextLimit = (): number => {
    const workerLimit = options.speech.readLimitBytes()
    if (!Number.isSafeInteger(workerLimit) || (workerLimit ?? 0) <= 0)
      throw new Error('SPEECH_PACK_KEY_WORKER_LIMIT_UNAVAILABLE')
    return Math.min(maxPlaintextBytes, workerLimit!)
  }

  const backendFor = (scope: SpeechPackReceiptKeyScope, root: SpeechPackReceiptRegistryRoot) => {
    assertCurrent(scope, root)
    const backend = native.selectedBackend()
    assertCurrent(scope, root)
    if (!backend) throw new Error('SPEECH_PACK_KEY_NATIVE_BACKEND_UNAVAILABLE')
    return backend
  }

  const verifyEnvelopeIdentity = (envelope: AnchorEnvelope, kLocal: string): void => {
    if (envelope.kLocal !== kLocal) throw new Error('SPEECH_PACK_KEY_ENVELOPE_BINDING_INVALID')
  }

  const decodeAnchor = async (
    scope: SpeechPackReceiptKeyScope,
    root: SpeechPackReceiptRegistryRoot,
    lease: ProtectedSpeechPackKeyAnchorLease
  ): Promise<{ key: Uint8Array; keyId: string; kLocal: string; backend: (typeof BACKENDS)[number] }> => {
    const backend = backendFor(scope, root)
    const envelope = decodeEnvelope(lease.bytes, maxAnchorBytes)
    let wrapped: Buffer | undefined
    let decoded = ''
    let key: Buffer | undefined
    try {
      await assertPhysicalCurrent(scope, root)
      await lease.assertCurrent()
      // The lease check awaits an owner-controlled operation; it cannot carry policy authority.
      // Recheck the captured scope and backend immediately before native unwrap.
      assertCurrent(scope, root)
      if (native.selectedBackend() !== backend) throw new Error('SPEECH_PACK_KEY_BACKEND_CHANGED')
      assertCurrent(scope, root)
      const wrappedText = envelope.kLocal.slice(2)
      wrapped = strictBase64(wrappedText, MAX_WRAPPED_KEY_BYTES)
      decoded = native.unwrap(wrapped)
      assertCurrent(scope, root)
      await assertPhysicalCurrent(scope, root)
      await lease.assertCurrent()
      if (native.selectedBackend() !== backend) throw new Error('SPEECH_PACK_KEY_BACKEND_CHANGED')
      key = strictBase64(decoded, 32)
      decoded = ''
      if (key.byteLength !== 32) throw new Error('SPEECH_PACK_KEY_ANCHOR_LOCKED')
      const workerKey = new Uint8Array(32)
      workerKey.set(key)
      let plaintext: string
      try {
        if (native.selectedBackend() !== backend) throw new Error('SPEECH_PACK_KEY_BACKEND_CHANGED')
        assertCurrent(scope, root)
        plaintext = await options.speech.decryptEnvelopeV2(envelope.json, workerKey, envelope.kLocal)
      } finally {
        zero(workerKey)
      }
      assertCurrent(scope, root)
      await assertPhysicalCurrent(scope, root)
      await lease.assertCurrent()
      if (native.selectedBackend() !== backend) throw new Error('SPEECH_PACK_KEY_BACKEND_CHANGED')
      const record = parseRecord(plaintext)
      if (!matches(record, scope, root, backend)) throw new Error('SPEECH_PACK_KEY_ASSOCIATION_MISMATCH')
      if (Buffer.byteLength(plaintext, 'utf8') > effectivePlaintextLimit())
        throw new Error('SPEECH_PACK_KEY_PLAINTEXT_OVERSIZED')
      const result = new Uint8Array(32)
      result.set(key)
      return { key: result, keyId: record.keyId, kLocal: envelope.kLocal, backend }
    } finally {
      zero(envelope.bytes)
      zero(envelope.json)
      if (wrapped) zero(wrapped)
      if (key) zero(key)
      decoded = ''
    }
  }

  const assertStateCurrent = (state: KeyState): void => {
    if (state.retired || state.disposed) throw new Error('SPEECH_PACK_KEY_HANDLE_RETIRED')
    assertCurrent(state.scope, state.registryRoot)
  }

  const assertStatePhysical = async (state: KeyState): Promise<void> => {
    assertStateCurrent(state)
    await assertPhysicalCurrent(state.scope, state.registryRoot)
    await state.lease.assertCurrent()
    assertStateCurrent(state)
  }

  const performEnvelope = async (
    state: KeyState,
    direction: 'encrypt' | 'decrypt',
    value: string | Uint8Array,
    useOpen: () => boolean
  ): Promise<Buffer | string> => {
    if (!useOpen()) throw new Error('SPEECH_PACK_KEY_USE_CLOSED')
    assertStateCurrent(state)
    const limit = effectivePlaintextLimit()
    let input: Buffer | undefined
    let parsed: AnchorEnvelope | undefined
    let key: Uint8Array | undefined
    let iv: Uint8Array | undefined
    let output: Buffer | undefined
    let transferOutput = false
    try {
      if (direction === 'encrypt') {
        if (typeof value !== 'string') throw new Error('SPEECH_PACK_KEY_INPUT_INVALID')
        // Reject by code-unit count before scanning; then exact UTF-8 measurement allocates no copy.
        if (value.length > limit || Buffer.byteLength(value, 'utf8') > limit)
          throw new Error('SPEECH_PACK_KEY_PLAINTEXT_OVERSIZED')
      } else {
        if (!(value instanceof Uint8Array) || value.byteLength < MAGIC.length + 1 || value.byteLength > maxAnchorBytes)
          throw new Error('SPEECH_PACK_KEY_ENVELOPE_OVERSIZED')
        input = Buffer.from(value)
        parsed = decodeEnvelope(input, maxAnchorBytes)
        verifyEnvelopeIdentity(parsed, state.expectedKLocal)
      }
      await assertStatePhysical(state)
      key = copyKey(state.key)
      if (direction === 'encrypt') {
        iv = new Uint8Array(randomBytes(12))
        output = await options.speech.encryptEnvelopeV2(value as string, key, iv, state.expectedKLocal)
        assertStateCurrent(state)
        await assertStatePhysical(state)
        if (output.byteLength > maxAnchorBytes) throw new Error('SPEECH_PACK_KEY_ENVELOPE_OVERSIZED')
        parsed = decodeEnvelope(output, maxAnchorBytes)
        verifyEnvelopeIdentity(parsed, state.expectedKLocal)
        zero(parsed.bytes)
        zero(parsed.json)
        parsed = undefined
        transferOutput = true
        return output
      }
      const plaintext = await options.speech.decryptEnvelopeV2(parsed!.json, key, state.expectedKLocal)
      assertStateCurrent(state)
      await assertStatePhysical(state)
      if (Buffer.byteLength(plaintext, 'utf8') > limit) throw new Error('SPEECH_PACK_KEY_PLAINTEXT_OVERSIZED')
      return plaintext
    } finally {
      if (key) zero(key)
      if (iv) zero(iv)
      if (input) zero(input)
      if (parsed) {
        zero(parsed.bytes)
        zero(parsed.json)
      }
      if (output && !transferOutput) zero(output)
    }
  }

  const makeHandle = (
    scope: SpeechPackReceiptKeyScope,
    root: SpeechPackReceiptRegistryRoot,
    lease: ProtectedSpeechPackKeyAnchorLease,
    key: Uint8Array,
    keyId: string,
    expectedKLocal: string
  ): SpeechPackReceiptKeyHandle => {
    const state: KeyState = {
      scope,
      registryRoot: root,
      lease,
      key,
      keyId,
      expectedKLocal,
      pending: new Set(),
      activeUses: 0,
      retired: false,
      disposed: false
    }
    let handle: SpeechPackReceiptKeyHandle
    handle = Object.freeze({
      keyId,
      expectedKLocal,
      assertCurrent: () => assertStateCurrent(state),
      withKeyUse: <T>(use: (keyUse: SpeechPackReceiptKeyUse) => T | Promise<T>): Promise<T> => {
        if (state.retired || state.disposed) return Promise.reject(new Error('SPEECH_PACK_KEY_HANDLE_RETIRED'))
        if (state.activeUses >= MAX_ACTIVE_KEY_USES)
          return Promise.reject(new Error('SPEECH_PACK_KEY_USE_LIMIT_EXCEEDED'))
        state.activeUses += 1
        const work = runKeyUse(state, use)
        state.pending.add(work)
        void work
          .finally(() => {
            state.pending.delete(work)
            state.activeUses -= 1
          })
          .catch(() => undefined)
        return work
      },
      retire: () => {
        state.retired = true
      },
      settleAndDispose: async () => {
        state.retired = true
        await Promise.allSettled([...state.pending])
        if (state.disposed) return
        state.key.fill(0)
        state.disposed = true
        handleStates.delete(handle)
        await lease.dispose()
      }
    })
    handleStates.set(handle, state)
    return handle
  }

  const runKeyUse = async <T>(
    state: KeyState,
    use: (keyUse: SpeechPackReceiptKeyUse) => T | Promise<T>
  ): Promise<T> => {
    assertStateCurrent(state)
    if (typeof use !== 'function') throw new Error('SPEECH_PACK_KEY_CALLBACK_REQUIRED')
    await assertStatePhysical(state)
    const operationOutcomes: Array<
      Promise<{ readonly failed: false } | { readonly failed: true; readonly error: unknown }>
    > = []
    let operationCount = 0
    let operationLimitFailure: Error | undefined
    let accepting = true
    const closedUse = Promise.reject(new Error('SPEECH_PACK_KEY_USE_CLOSED'))
    const operationLimit = Promise.reject(new Error('SPEECH_PACK_KEY_OPERATION_LIMIT_EXCEEDED'))
    void closedUse.catch(() => undefined)
    void operationLimit.catch(() => undefined)
    const execute = <R>(direction: 'encrypt' | 'decrypt', value: string | Uint8Array): Promise<R> => {
      if (!accepting) return closedUse as Promise<R>
      if (operationCount >= MAX_OPERATIONS_PER_KEY_USE) {
        operationLimitFailure ??= new Error('SPEECH_PACK_KEY_OPERATION_LIMIT_EXCEEDED')
        return operationLimit as Promise<R>
      }
      operationCount += 1
      const operation = performEnvelope(state, direction, value, () => accepting)
      const outcome = operation.then(
        () => ({ failed: false as const }),
        (error: unknown) => ({ failed: true as const, error })
      )
      operationOutcomes.push(outcome)
      state.pending.add(operation)
      void outcome.then(() => {
        state.pending.delete(operation)
      })
      return operation as Promise<R>
    }
    const keyUse: SpeechPackReceiptKeyUse = Object.freeze({
      encrypt: (plaintext: string) => execute<Buffer>('encrypt', plaintext),
      decrypt: (envelopeBytes: Uint8Array) => execute<string>('decrypt', envelopeBytes)
    })
    let result!: T
    let callbackError: unknown
    let callbackFailed = false
    try {
      result = await use(keyUse)
    } catch (error) {
      callbackFailed = true
      callbackError = error
    } finally {
      accepting = false
    }
    const settled = await Promise.all(operationOutcomes)
    const operationError = settled.find((entry) => entry.failed)
    if (callbackFailed) throw callbackError
    if (operationError?.failed) throw operationError.error
    if (operationLimitFailure) throw operationLimitFailure
    assertStateCurrent(state)
    return result
  }

  const service: ProtectedSpeechPackReceiptKeys = {
    async createForExplicitInstall(scope, registryRoot) {
      assertIdentity(scope, registryRoot)
      await assertPhysicalCurrent(scope, registryRoot)
      const backend = backendFor(scope, registryRoot)
      const key = new Uint8Array(randomBytes(32))
      const keyId = randomBytes(16).toString('hex')
      let wrapped: Buffer | undefined
      let envelope: Buffer | undefined
      let kLocal = ''
      let lease: ProtectedSpeechPackKeyAnchorLease | undefined
      try {
        const contentKeyBase64 = Buffer.from(key).toString('base64')
        wrapped = native.wrap(contentKeyBase64)
        assertCurrent(scope, registryRoot)
        if (
          native.selectedBackend() !== backend ||
          wrapped.byteLength === 0 ||
          wrapped.byteLength > MAX_WRAPPED_KEY_BYTES
        )
          throw new Error('SPEECH_PACK_KEY_NATIVE_WRAP_FAILED')
        kLocal = `S:${wrapped.toString('base64')}`
        const record = makeRecord(scope, registryRoot, keyId, backend)
        const plaintext = JSON.stringify(record)
        if (Buffer.byteLength(plaintext, 'utf8') > effectivePlaintextLimit())
          throw new Error('SPEECH_PACK_KEY_PLAINTEXT_OVERSIZED')
        const workerKey = new Uint8Array(32)
        const iv = new Uint8Array(randomBytes(12))
        workerKey.set(key)
        try {
          await assertPhysicalCurrent(scope, registryRoot)
          envelope = await options.speech.encryptEnvelopeV2(plaintext, workerKey, iv, kLocal)
        } finally {
          zero(workerKey)
          zero(iv)
        }
        assertCurrent(scope, registryRoot)
        await assertPhysicalCurrent(scope, registryRoot)
        if (native.selectedBackend() !== backend || envelope.byteLength > maxAnchorBytes)
          throw new Error('SPEECH_PACK_KEY_ENVELOPE_OVERSIZED')
        const parsed = decodeEnvelope(envelope, maxAnchorBytes)
        try {
          verifyEnvelopeIdentity(parsed, kLocal)
        } finally {
          zero(parsed.bytes)
          zero(parsed.json)
        }
        lease = await options.anchorOwner.createExclusive(scope, registryRoot, envelope, maxAnchorBytes)
        await assertPhysicalCurrent(scope, registryRoot)
        await lease.assertCurrent()
        if (!Buffer.from(lease.bytes).equals(envelope)) throw new Error('SPEECH_PACK_KEY_ANCHOR_READBACK_MISMATCH')
        // Authenticate the exact bytes after publication before returning any usable handle.
        const opened = await decodeAnchor(scope, registryRoot, lease)
        try {
          if (opened.keyId !== keyId || !Buffer.from(opened.key).equals(Buffer.from(key)))
            throw new Error('SPEECH_PACK_KEY_ANCHOR_READBACK_MISMATCH')
        } finally {
          zero(opened.key)
        }
        assertCurrent(scope, registryRoot)
        return makeHandle(scope, registryRoot, lease, key, keyId, kLocal)
      } catch (error) {
        key.fill(0)
        await lease?.dispose().catch(() => undefined)
        throw error
      } finally {
        if (wrapped) zero(wrapped)
        if (envelope) zero(envelope)
        kLocal = ''
      }
    },

    async openExistingForRecovery(scope, registryRoot) {
      assertIdentity(scope, registryRoot)
      await assertPhysicalCurrent(scope, registryRoot)
      const lease = await options.anchorOwner.openExisting(scope, registryRoot, maxAnchorBytes)
      if (!lease) throw new Error('SPEECH_PACK_KEY_ANCHOR_MISSING')
      let opened: Awaited<ReturnType<typeof decodeAnchor>> | undefined
      try {
        await assertPhysicalCurrent(scope, registryRoot)
        await lease.assertCurrent()
        opened = await decodeAnchor(scope, registryRoot, lease)
        await assertPhysicalCurrent(scope, registryRoot)
        await lease.assertCurrent()
        assertCurrent(scope, registryRoot)
        const result = makeHandle(scope, registryRoot, lease, opened.key, opened.keyId, opened.kLocal)
        return result
      } catch (error) {
        if (opened) zero(opened.key)
        await lease.dispose().catch(() => undefined)
        throw error
      }
    },

    retire(handle) {
      const state = handleStates.get(handle)
      if (!state) throw new Error('SPEECH_PACK_KEY_HANDLE_UNKNOWN')
      state.retired = true
    },

    async settleAndDispose(handle) {
      const state = handleStates.get(handle)
      if (!state) throw new Error('SPEECH_PACK_KEY_HANDLE_UNKNOWN')
      await handle.settleAndDispose()
    }
  }
  return service
}
