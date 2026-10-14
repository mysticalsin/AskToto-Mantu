import { describe, expect, it } from 'vitest'
import type { MeetingSpeechPersistenceService } from '../infra/process/meeting-speech-host'
import type { NativeKeyStore } from './protected-meeting-keys'
import {
  createProtectedSpeechPackReceiptKeys,
  type ProtectedSpeechPackReceiptKeysOptions
} from './protected-speech-pack-receipt-keys'
import type {
  ProtectedSpeechPackKeyAnchorLease,
  ProtectedSpeechPackKeyAnchorOwner,
  SpeechPackReceiptKeyScope,
  SpeechPackReceiptRegistryRoot
} from './speech-pack-receipt-key-contract'

const MAGIC = Buffer.from('ATKENC2\n')
const TEST_ROOT = 'a'.repeat(64)

function fixture() {
  // The fixture encryptor only exercises key-service plumbing. It is not native-key or AES qualification;
  // the installed meeting-speech host tests own the real v2 crypto contract.
  let anchor: Buffer | undefined
  let scopeCurrent = true
  let rootCurrent = true
  let workerDecryptCalls = 0
  let workerEncryptCalls = 0
  let nativeUnwrapCalls = 0
  let authenticatedLeaseAdmissions = 0
  let holdNextEncrypt = false
  let notifyEncryptHeld: (() => void) | undefined
  let releaseEncrypt: (() => void) | undefined
  let holdNextLeaseAssertion = false
  let notifyLeaseHeld: (() => void) | undefined
  let releaseLeaseAssertion: (() => void) | undefined
  let rejectNextEncrypt = false
  let notifyEncryptRejected: (() => void) | undefined
  const scope: SpeechPackReceiptKeyScope = {
    profileNamespace: 'fixture-profile',
    principalAssociation: 'fixture-principal',
    profileGeneration: 'generation-1',
    nativeKeyAccess: 'allowed',
    intent: 'explicit-pack-maintenance',
    assertCurrent: () => {
      if (!scopeCurrent) throw new Error('STALE_SCOPE')
    },
    assertPhysicalCurrent: async () => {
      if (!scopeCurrent) throw new Error('STALE_SCOPE')
    }
  }
  const root: SpeechPackReceiptRegistryRoot = {
    bindingId: TEST_ROOT,
    assertCurrent: () => {
      if (!rootCurrent) throw new Error('STALE_ROOT')
    },
    assertPhysicalCurrent: async () => {
      if (!rootCurrent) throw new Error('STALE_ROOT')
    }
  }
  const makeLease = (bytes: Buffer): ProtectedSpeechPackKeyAnchorLease => {
    const owned = Buffer.from(bytes)
    let disposed = false
    return {
      bytes: owned,
      assertCurrent: async () => {
        if (holdNextLeaseAssertion) {
          holdNextLeaseAssertion = false
          notifyLeaseHeld?.()
          notifyLeaseHeld = undefined
          await new Promise<void>((resolve) => {
            releaseLeaseAssertion = resolve
          })
        }
        if (disposed || !anchor?.equals(owned)) throw new Error('ANCHOR_CHANGED')
      },
      admitAuthenticated: async (keyId, authenticatedBytes) => {
        if (disposed || !anchor?.equals(owned) || !Buffer.from(authenticatedBytes).equals(owned))
          throw new Error('ANCHOR_AUTHENTICATION_CHANGED')
        if (!/^[a-f0-9]{32}$/.test(keyId)) throw new Error('ANCHOR_KEY_ID_INVALID')
        authenticatedLeaseAdmissions += 1
      },
      dispose: async () => {
        disposed = true
        owned.fill(0)
      }
    }
  }
  const anchorOwner: ProtectedSpeechPackKeyAnchorOwner = {
    async openExisting() {
      return anchor ? makeLease(anchor) : null
    },
    async createExclusive(_scope, _root, bytes, keyId, maxBytes) {
      if (anchor || bytes.byteLength > maxBytes) throw new Error('ANCHOR_ALREADY_EXISTS_OR_OVERSIZED')
      if (!/^[a-f0-9]{32}$/.test(keyId)) throw new Error('ANCHOR_KEY_ID_INVALID')
      anchor = Buffer.from(bytes)
      return makeLease(anchor)
    }
  }
  const native: NativeKeyStore = {
    selectedBackend: () => 'macos-keychain',
    wrap: (value) => Buffer.from(value, 'utf8'),
    unwrap: (value) => {
      nativeUnwrapCalls += 1
      return value.toString('utf8')
    }
  }
  const speech: Pick<MeetingSpeechPersistenceService, 'encryptEnvelopeV2' | 'decryptEnvelopeV2' | 'readLimitBytes'> = {
    readLimitBytes: () => 49_152,
    async encryptEnvelopeV2(plaintext, key, iv, kLocal) {
      workerEncryptCalls += 1
      if (key.byteLength !== 32 || iv.byteLength !== 12) throw new Error('TEST_WORKER_INPUT_INVALID')
      if (rejectNextEncrypt) {
        rejectNextEncrypt = false
        notifyEncryptRejected?.()
        notifyEncryptRejected = undefined
        throw new Error('TEST_ENCRYPT_REJECTED')
      }
      if (holdNextEncrypt) {
        holdNextEncrypt = false
        notifyEncryptHeld?.()
        notifyEncryptHeld = undefined
        await new Promise<void>((resolve) => {
          releaseEncrypt = resolve
        })
      }
      const envelope = {
        v: 2,
        iv: Buffer.from(iv).toString('base64'),
        tag: Buffer.alloc(16).toString('base64'),
        ct: Buffer.from(plaintext, 'utf8').toString('base64'),
        kLocal
      }
      return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(envelope), 'utf8')])
    },
    async decryptEnvelopeV2(envelopeJson, key, kLocal) {
      workerDecryptCalls += 1
      if (key.byteLength !== 32) throw new Error('TEST_WORKER_KEY_INVALID')
      const envelope = JSON.parse(Buffer.from(envelopeJson).toString('utf8')) as Record<string, unknown>
      if (envelope.kLocal !== kLocal) throw new Error('TEST_WORKER_KLOCAL_MISMATCH')
      return Buffer.from(String(envelope.ct), 'base64').toString('utf8')
    }
  }
  const options: ProtectedSpeechPackReceiptKeysOptions = { anchorOwner, speech, nativeKeyStore: native }
  return {
    service: createProtectedSpeechPackReceiptKeys(options),
    scope,
    root,
    setScopeCurrent(value: boolean) {
      scopeCurrent = value
    },
    setRootCurrent(value: boolean) {
      rootCurrent = value
    },
    setNativeAccessDisabled() {
      Object.defineProperty(scope, 'nativeKeyAccess', { value: 'explicitly-disabled' })
    },
    changeRootBinding(value: string) {
      Object.defineProperty(root, 'bindingId', { value, configurable: true })
    },
    holdEncrypt() {
      holdNextEncrypt = true
      return new Promise<void>((resolve) => {
        notifyEncryptHeld = resolve
      })
    },
    releaseEncrypt() {
      releaseEncrypt?.()
      releaseEncrypt = undefined
    },
    holdLeaseAssertion() {
      holdNextLeaseAssertion = true
      return new Promise<void>((resolve) => {
        notifyLeaseHeld = resolve
      })
    },
    releaseLeaseAssertion() {
      releaseLeaseAssertion?.()
      releaseLeaseAssertion = undefined
    },
    rejectNextEncryption() {
      rejectNextEncrypt = true
      return new Promise<void>((resolve) => {
        notifyEncryptRejected = resolve
      })
    },
    workerEncryptCalls: () => workerEncryptCalls,
    nativeUnwrapCalls: () => nativeUnwrapCalls,
    decryptCalls: () => workerDecryptCalls,
    authenticatedLeaseAdmissions: () => authenticatedLeaseAdmissions,
    readAnchor: () => (anchor ? Buffer.from(anchor) : undefined)
  }
}

function envelopeWithLocalKey(bytes: Buffer, kLocal: string): Buffer {
  const parsed = JSON.parse(bytes.subarray(MAGIC.length).toString('utf8')) as Record<string, unknown>
  parsed.kLocal = kLocal
  return Buffer.concat([MAGIC, Buffer.from(JSON.stringify(parsed), 'utf8')])
}

describe('ProtectedSpeechPackReceiptKeys', () => {
  it('creates and reopens only the purpose-bound key, delegating envelope use with its captured kLocal', async () => {
    const f = fixture()
    const created = await f.service.createForExplicitInstall(f.scope, f.root)
    expect(created.keyId).toMatch(/^[a-f0-9]{32}$/)
    expect(created.expectedKLocal.startsWith('S:')).toBe(true)
    expect(f.authenticatedLeaseAdmissions()).toBe(1)

    let storedEnvelope: Buffer | undefined
    await created.withKeyUse(async (keyUse) => {
      const envelope = await keyUse.encrypt('{"schema":1,"owned":true}')
      storedEnvelope = envelope
      await expect(keyUse.decrypt(envelope)).resolves.toBe('{"schema":1,"owned":true}')
    })
    expect(storedEnvelope?.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true)
    await created.settleAndDispose()

    const reopened = await f.service.openExistingForRecovery(f.scope, f.root)
    expect(reopened.keyId).toBe(created.keyId)
    expect(f.authenticatedLeaseAdmissions()).toBe(2)
    await expect(reopened.withKeyUse((keyUse) => keyUse.decrypt(storedEnvelope!))).resolves.toBe(
      '{"schema":1,"owned":true}'
    )
    await reopened.settleAndDispose()
  })

  it('rejects a changed registry binding and explicit native opt-out without healing the anchor', async () => {
    const f = fixture()
    const handle = await f.service.createForExplicitInstall(f.scope, f.root)
    await handle.settleAndDispose()
    const before = f.readAnchor()!
    f.changeRootBinding('b'.repeat(64))
    await expect(f.service.openExistingForRecovery(f.scope, f.root)).rejects.toThrow(
      'SPEECH_PACK_KEY_ASSOCIATION_MISMATCH'
    )
    f.changeRootBinding(TEST_ROOT)
    const unwrapCalls = f.nativeUnwrapCalls()
    f.setNativeAccessDisabled()
    await expect(f.service.openExistingForRecovery(f.scope, f.root)).rejects.toThrow(
      'SPEECH_PACK_KEY_NATIVE_ACCESS_DISABLED'
    )
    expect(f.readAnchor()?.equals(before)).toBe(true)
    expect(f.nativeUnwrapCalls()).toBe(unwrapCalls)
  })

  it('rejects caller-substituted kLocal before invoking the worker decryptor', async () => {
    const f = fixture()
    const handle = await f.service.createForExplicitInstall(f.scope, f.root)
    const forged = envelopeWithLocalKey(f.readAnchor()!, 'S:Zm9yZ2Vk')
    const before = f.decryptCalls()
    await expect(handle.withKeyUse((keyUse) => keyUse.decrypt(forged))).rejects.toThrow(
      'SPEECH_PACK_KEY_ENVELOPE_BINDING_INVALID'
    )
    expect(f.decryptCalls()).toBe(before)
    await handle.settleAndDispose()
  })

  it('checks the original scope again after a held worker await', async () => {
    const f = fixture()
    const handle = await f.service.createForExplicitInstall(f.scope, f.root)
    const held = f.holdEncrypt()
    const result = handle.withKeyUse((keyUse) => keyUse.encrypt('{"phase":"pending"}'))
    await held
    f.setScopeCurrent(false)
    f.releaseEncrypt()
    await expect(result).rejects.toThrow('STALE_SCOPE')
    await handle.settleAndDispose()
  })

  it('rechecks scope and native opt-out after a held anchor lease before any unwrap or worker call', async () => {
    const stale = fixture()
    const staleHandle = await stale.service.createForExplicitInstall(stale.scope, stale.root)
    await staleHandle.settleAndDispose()
    const staleUnwraps = stale.nativeUnwrapCalls()
    const staleDecrypts = stale.decryptCalls()
    const staleLeaseHeld = stale.holdLeaseAssertion()
    const staleOpen = stale.service.openExistingForRecovery(stale.scope, stale.root)
    await staleLeaseHeld
    stale.setScopeCurrent(false)
    stale.releaseLeaseAssertion()
    await expect(staleOpen).rejects.toThrow('STALE_SCOPE')
    expect(stale.nativeUnwrapCalls()).toBe(staleUnwraps)
    expect(stale.decryptCalls()).toBe(staleDecrypts)

    const optedOut = fixture()
    const optedOutHandle = await optedOut.service.createForExplicitInstall(optedOut.scope, optedOut.root)
    await optedOutHandle.settleAndDispose()
    const optedOutUnwraps = optedOut.nativeUnwrapCalls()
    const optedOutDecrypts = optedOut.decryptCalls()
    const optOutLeaseHeld = optedOut.holdLeaseAssertion()
    const optedOutOpen = optedOut.service.openExistingForRecovery(optedOut.scope, optedOut.root)
    await optOutLeaseHeld
    optedOut.setNativeAccessDisabled()
    optedOut.releaseLeaseAssertion()
    await expect(optedOutOpen).rejects.toThrow('SPEECH_PACK_KEY_NATIVE_ACCESS_DISABLED')
    expect(optedOut.nativeUnwrapCalls()).toBe(optedOutUnwraps)
    expect(optedOut.decryptCalls()).toBe(optedOutDecrypts)
  })

  it('bounds UTF-8 before worker admission and clears parsed input when authority expires', async () => {
    const f = fixture()
    const handle = await f.service.createForExplicitInstall(f.scope, f.root)
    const callsBeforeOversize = f.workerEncryptCalls()
    await expect(handle.withKeyUse((keyUse) => keyUse.encrypt('é'.repeat(24_577)))).rejects.toThrow(
      'SPEECH_PACK_KEY_PLAINTEXT_OVERSIZED'
    )
    expect(f.workerEncryptCalls()).toBe(callsBeforeOversize)

    const envelope = await handle.withKeyUse((keyUse) => keyUse.encrypt('{"ok":true}'))
    const callsBeforeDecrypt = f.decryptCalls()
    const useResult = handle.withKeyUse(async (keyUse) => {
      const leaseHeld = f.holdLeaseAssertion()
      const decryptResult = keyUse.decrypt(envelope)
      await leaseHeld
      f.setScopeCurrent(false)
      f.releaseLeaseAssertion()
      await expect(decryptResult).rejects.toThrow('STALE_SCOPE')
    })
    await expect(useResult).rejects.toThrow('STALE_SCOPE')
    expect(f.decryptCalls()).toBe(callsBeforeDecrypt)
    await handle.settleAndDispose()
  })

  it('preserves a fire-and-forget operation failure until the callback finishes', async () => {
    const f = fixture()
    const handle = await f.service.createForExplicitInstall(f.scope, f.root)
    const failureReachedWorker = f.rejectNextEncryption()
    let finishCallback!: () => void
    const callbackGate = new Promise<void>((resolve) => {
      finishCallback = resolve
    })
    const useResult = handle.withKeyUse(async (keyUse) => {
      void keyUse.encrypt('{"fireAndForget":true}')
      await failureReachedWorker
      await callbackGate
      return 'callback-completed'
    })
    await failureReachedWorker
    finishCallback()
    await expect(useResult).rejects.toThrow('TEST_ENCRYPT_REJECTED')
    await handle.settleAndDispose()
  })

  it('caps aggregate key operations and waits for pending use before disposal', async () => {
    const f = fixture()
    const handle = await f.service.createForExplicitInstall(f.scope, f.root)
    const callsBefore = f.workerEncryptCalls()
    await expect(
      handle.withKeyUse(async (keyUse) => {
        const attempts = Array.from({ length: 5 }, (_, index) => keyUse.encrypt(`{"n":${index}}`))
        await Promise.allSettled(attempts)
      })
    ).rejects.toThrow('SPEECH_PACK_KEY_OPERATION_LIMIT_EXCEEDED')
    expect(f.workerEncryptCalls() - callsBefore).toBe(4)

    const held = f.holdEncrypt()
    const pendingUse = handle.withKeyUse((keyUse) => keyUse.encrypt('{"pending":true}'))
    await held
    let disposed = false
    const disposal = handle.settleAndDispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    f.releaseEncrypt()
    await expect(pendingUse).rejects.toThrow('SPEECH_PACK_KEY_HANDLE_RETIRED')
    await disposal
    const settledCalls = f.workerEncryptCalls()
    await expect(handle.withKeyUse((keyUse) => keyUse.encrypt('late'))).rejects.toThrow(
      'SPEECH_PACK_KEY_HANDLE_RETIRED'
    )
    expect(f.workerEncryptCalls()).toBe(settledCalls)
  })
})
