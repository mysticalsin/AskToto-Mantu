import { describe, expect, it } from 'vitest'
import {
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

const snapshot = (): PackRegistrySnapshot => ({
  schema: 1,
  purpose: SPEECH_PACK_RECEIPT_PURPOSE,
  binding: {
    profileNamespace: 'development-profile',
    profileGeneration: 'generation-1',
    principalAssociation: 'principal-1',
    registryRootBinding: 'registry-root-1',
    keyId: 'key-1',
    keyAnchorIdentity: identity,
    registryRootIdentity: identity,
    packRootIdentity: identity
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
