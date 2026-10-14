import { constants, type BigIntStats } from 'node:fs'
import { lstat, opendir, type FileHandle } from 'node:fs/promises'
import type { RuntimeStableFileOwner, RuntimeStableOwner } from './runtime-purpose-root'
import type {
  CandidateState,
  NamespaceState,
  RegistrySlot,
  RuntimeRegistryPublicationBinding
} from './runtime-owned-registry-state'

const SLOT_MEMBERS = ['registry.0.v1', 'registry.1.v1'] as const
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

export const MAX_REGISTRY_FRAME_BYTES = 65_536
export const MAX_REGISTRY_DIRECTORY_CHILDREN = 4

export function memberForSlot(slot: RegistrySlot): (typeof SLOT_MEMBERS)[number] {
  if (slot !== 0 && slot !== 1) throw new Error('RUNTIME_REGISTRY_SLOT_INVALID')
  return SLOT_MEMBERS[slot]
}

export function ownerRecord(version: BigIntStats): RuntimeStableFileOwner {
  if (!version.isFile() || version.isSymbolicLink() || version.nlink !== 1n) {
    throw new Error('RUNTIME_REGISTRY_FILE_INVALID')
  }
  return Object.freeze({
    dev: version.dev.toString(),
    ino: version.ino.toString(),
    birthtimeNs: version.birthtimeNs.toString(),
    mode: version.mode.toString(),
    uid: version.uid.toString(),
    gid: version.gid.toString(),
    rdev: version.rdev.toString(),
    nlink: '1'
  })
}

function stableDirectoryRecord(version: BigIntStats): RuntimeStableOwner {
  if (!version.isDirectory() || version.isSymbolicLink()) throw new Error('RUNTIME_REGISTRY_ROOT_INVALID')
  return Object.freeze({
    dev: version.dev.toString(),
    ino: version.ino.toString(),
    birthtimeNs: version.birthtimeNs.toString(),
    mode: version.mode.toString(),
    uid: version.uid.toString(),
    gid: version.gid.toString(),
    rdev: version.rdev.toString()
  })
}

export function sameOwner(expected: RuntimeStableOwner, actual: BigIntStats): boolean {
  const value = stableDirectoryRecord(actual)
  return (
    expected.dev === value.dev &&
    expected.ino === value.ino &&
    expected.birthtimeNs === value.birthtimeNs &&
    expected.mode === value.mode &&
    expected.uid === value.uid &&
    expected.gid === value.gid &&
    expected.rdev === value.rdev
  )
}

export function sameFileOwner(expected: RuntimeStableFileOwner, actual: BigIntStats): boolean {
  const value = ownerRecord(actual)
  return (
    expected.dev === value.dev &&
    expected.ino === value.ino &&
    expected.birthtimeNs === value.birthtimeNs &&
    expected.mode === value.mode &&
    expected.uid === value.uid &&
    expected.gid === value.gid &&
    expected.rdev === value.rdev &&
    expected.nlink === value.nlink
  )
}

export function exactMemberSet(expected: readonly string[], actual: readonly string[]): boolean {
  return [...expected].sort().join('\0') === [...actual].sort().join('\0')
}

export async function readNames(path: string, maximum: number): Promise<string[]> {
  const directory = await opendir(path, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = await directory.read()
      if (!entry) return names
      if (names.length >= maximum) throw new Error('RUNTIME_REGISTRY_MEMBER_LIMIT')
      names.push(entry.name)
    }
  } finally {
    await directory.close()
  }
}

export async function boundedRead(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_REGISTRY_FRAME_BYTES) {
    throw new Error('RUNTIME_REGISTRY_FRAME_LIMIT')
  }
  const buffer = Buffer.alloc(expectedBytes + 1)
  let offset = 0
  while (offset < expectedBytes + 1) {
    const result = await handle.read(buffer, offset, expectedBytes + 1 - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset !== expectedBytes) throw new Error('RUNTIME_REGISTRY_FRAME_LENGTH_CHANGED')
  return Buffer.from(buffer.subarray(0, expectedBytes))
}

export function validatePublication(
  state: NamespaceState,
  value: RuntimeRegistryPublicationBinding,
  candidate: CandidateState
): void {
  const fields = Object.keys(value).sort().join('\0')
  if (
    fields !==
      ['createdOwner', 'keyId', 'publicationId', 'purpose', 'replacesDigest', 'rootBinding', 'schemaVersion', 'slot']
        .sort()
        .join('\0') ||
    value.schemaVersion !== 1 ||
    value.purpose !== 'metis-speech-pack-registry-slot/v1' ||
    value.rootBinding !== state.rootBinding ||
    value.keyId !== state.keyId ||
    (candidate.member === 'registry.pending.v1'
      ? value.slot !== 0 && value.slot !== 1
      : memberForSlot(value.slot) !== candidate.member) ||
    !/^[a-f0-9-]{36}$/.test(value.publicationId) ||
    !sameFileOwner(value.createdOwner, candidate.version) ||
    (value.replacesDigest !== null && !/^[a-f0-9]{64}$/.test(value.replacesDigest))
  ) {
    throw new Error('RUNTIME_REGISTRY_PUBLICATION_INVALID')
  }
}
