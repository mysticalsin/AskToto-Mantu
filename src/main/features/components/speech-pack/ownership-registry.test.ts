import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createSpeechPackOwnershipStore,
  SPEECH_PACK_RECEIPT_PURPOSE,
  validatePackRegistrySnapshot,
  type PackRegistrySnapshot
} from './ownership-registry'

const identity = {
  dev: '1',
  ino: '2',
  mode: '16832',
  nlink: '1',
  uid: '501',
  gid: '20',
  rdev: '0',
  size: '0',
  blocks: '0',
  mtimeNs: '3',
  ctimeNs: '4',
  birthtimeNs: '5',
  fileId: null
}
const stableIdentity = { dev: identity.dev, ino: identity.ino, birthtimeNs: identity.birthtimeNs }

const snapshot = (): PackRegistrySnapshot => ({
  schema: 1,
  purpose: SPEECH_PACK_RECEIPT_PURPOSE,
  binding: {
    profileNamespace: 'development-profile',
    profileGeneration: 'generation-1',
    principalAssociation: 'principal-1',
    registryRootBinding: 'registry-root-1',
    keyId: 'key-1',
    keyAnchorIdentity: stableIdentity,
    registryRootIdentity: stableIdentity,
    packRootIdentity: stableIdentity
  },
  sequence: '1',
  previousDigest: null,
  transactions: [
    {
      id: 'tx_1',
      componentId: 'asr.whisper-base-q8',
      version: '1',
      manifestIdentity: 'a'.repeat(64),
      phase: 'install-intent',
      previousMarkerBase64: null,
      previousMarkerWasAbsent: true,
      nodes: [],
      moves: [],
      supersedes: [],
      cleanupRemaining: []
    }
  ]
})

describe('speech-pack ownership registry schema', () => {
  it('accepts a bounded, purpose-bound transaction snapshot', () => {
    expect(validatePackRegistrySnapshot(snapshot())).toBe(true)
  })

  it('requires the complete physical identity tuple including rdev', () => {
    const value = snapshot()
    value.transactions[0]?.nodes.push({
      path: 'tree',
      kind: 'directory',
      origin: 'writer-created',
      identity: { ...identity },
      sha256: null,
      bytes: null
    })
    expect(validatePackRegistrySnapshot(value)).toBe(true)
    const missingRdev = snapshot()
    missingRdev.transactions[0]?.nodes.push({
      path: 'tree',
      kind: 'directory',
      origin: 'writer-created',
      identity: { ...identity },
      sha256: null,
      bytes: null
    })
    delete (missingRdev.transactions[0]?.nodes[0]?.identity as Partial<typeof identity>).rdev
    expect(validatePackRegistrySnapshot(missingRdev)).toBe(false)
  })

  it('rejects mutable metadata in persistent root bindings', () => {
    const value = snapshot()
    const movedMetadata = {
      ...value.binding.registryRootIdentity,
      mtimeNs: '20',
      ctimeNs: '21'
    }
    expect(
      validatePackRegistrySnapshot({
        ...value,
        binding: { ...value.binding, registryRootIdentity: movedMetadata }
      })
    ).toBe(false)
  })

  it('publishes sequence one when explicitly creating an empty registry', async () => {
    const publications: { slot: 0 | 1; bytes: Uint8Array }[] = []
    const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
    const store = await createSpeechPackOwnershipStore({
      binding: snapshot().binding,
      protector: {
        keyId: 'key-1',
        async encrypt(bytes) {
          return Uint8Array.from(bytes)
        },
        async decrypt(bytes) {
          return Uint8Array.from(bytes)
        },
        assertCurrent() {},
        retire() {},
        async settleAndDispose() {}
      },
      backend: {
        async readSlot() {
          return null
        },
        async publishSlot(input) {
          publications.push({ slot: input.slot, bytes: Uint8Array.from(input.bytes) })
          return { digest: digest(input.bytes), durable: true }
        },
        async acquireWriter() {
          return { async release() {} }
        }
      },
      mode: 'create-explicit'
    })
    expect(store.snapshot().sequence).toBe('1')
    expect(publications).toHaveLength(1)
    expect(publications[0]?.slot).toBe(0)
    await store.settleAndDispose()
  })

  it('serializes overlapping updates without losing a transaction', async () => {
    const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
    const store = await createSpeechPackOwnershipStore({
      binding: snapshot().binding,
      protector: {
        keyId: 'key-1',
        async encrypt(bytes) {
          await Promise.resolve()
          return Uint8Array.from(bytes)
        },
        async decrypt(bytes) {
          return Uint8Array.from(bytes)
        },
        assertCurrent() {},
        retire() {},
        async settleAndDispose() {}
      },
      backend: {
        async readSlot() {
          return null
        },
        async publishSlot(input) {
          await Promise.resolve()
          return { digest: digest(input.bytes), durable: true }
        },
        async acquireWriter() {
          return { async release() {} }
        }
      },
      mode: 'create-explicit'
    })
    await Promise.all([
      store.beginInstall({
        componentId: 'asr.whisper-base-q8',
        version: '1',
        manifestIdentity: 'a'.repeat(64),
        transactionId: 'tx_1',
        originalMarkerBase64: null,
        previousMarkerWasAbsent: true
      }),
      store.beginInstall({
        componentId: 'asr.whisper-base-q8',
        version: '1',
        manifestIdentity: 'b'.repeat(64),
        transactionId: 'tx_2',
        originalMarkerBase64: null,
        previousMarkerWasAbsent: true
      })
    ])
    expect(store.snapshot().sequence).toBe('3')
    expect(store.snapshot().transactions.map((transaction) => transaction.id)).toEqual(['tx_1', 'tx_2'])
    await store.settleAndDispose()
  })

  it.each([
    ['wrong purpose', (value: PackRegistrySnapshot) => ({ ...value, purpose: 'metis-protected-meeting-key/v2' })],
    [
      'numeric inode',
      (value: PackRegistrySnapshot) => ({
        ...value,
        binding: { ...value.binding, packRootIdentity: { ...identity, ino: 2 } }
      })
    ],
    ['noncanonical sequence', (value: PackRegistrySnapshot) => ({ ...value, sequence: '01' })],
    [
      'absolute node path',
      (value: PackRegistrySnapshot) => ({
        ...value,
        transactions: [
          {
            ...value.transactions[0],
            nodes: [
              { path: '/foreign', kind: 'directory', origin: 'writer-created', identity, sha256: null, bytes: null }
            ]
          }
        ]
      })
    ],
    ['unknown schema field', (value: PackRegistrySnapshot) => ({ ...value, deleteAnyMatchingPrefix: true })]
  ])('rejects %s', (_name, mutate) => {
    expect(validatePackRegistrySnapshot(mutate(snapshot()))).toBe(false)
  })
})
