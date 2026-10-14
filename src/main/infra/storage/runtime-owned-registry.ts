import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  prepareRuntimePhysicalAdmission,
  readRuntimeDirectoryNamesSync,
  readRuntimeNamedVersionSync,
  renameRuntimeDirectorySyncAfterAdmission,
  sameRuntimeFileVersion,
  type RuntimePhysicalSnapshotInput
} from './runtime-owned-files'
import {
  assertRuntimeSpeechPackPurposeRootCurrent,
  describeRuntimeSpeechPackPurposeRoot,
  type RuntimeSpeechPackPurposeRoot,
  type RuntimeStableFileOwner
} from './runtime-purpose-root'
import {
  candidates,
  issuers,
  namespaces,
  renameReceipts,
  replacements,
  scratches,
  slots,
  type CandidateState,
  type NamespaceState,
  type RecordIssuerState,
  type RegistrySlot,
  type RenameReceiptState,
  type ReplaceAdmissionState,
  type RuntimeOwnedRegistrySlot,
  type RuntimeRegistryCandidate,
  type RuntimeRegistryNamespace,
  type RuntimeRegistryPublicationBinding,
  type RuntimeRegistryRenameReceipt,
  type RuntimeRegistryReplaceAdmission,
  type RuntimeRegistryScratch,
  type ScratchState,
  type SlotState
} from './runtime-owned-registry-state'
export type {
  RegistrySlot,
  RuntimeOwnedRegistrySlot,
  RuntimeRegistryCandidate,
  RuntimeRegistryNamespace,
  RuntimeRegistryPublicationBinding,
  RuntimeRegistryRenameReceipt,
  RuntimeRegistryReplaceAdmission,
  RuntimeRegistryScratch
} from './runtime-owned-registry-state'
import {
  boundedRead,
  exactMemberSet,
  MAX_REGISTRY_DIRECTORY_CHILDREN,
  MAX_REGISTRY_FRAME_BYTES,
  memberForSlot,
  ownerRecord,
  readNames,
  sameFileOwner,
  sameOwner,
  validatePublication
} from './runtime-owned-registry-support'

const FIXED_MEMBERS = ['key.v1', 'registry.0.v1', 'registry.1.v1', 'registry.pending.v1'] as const
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

async function assertNamespaceCurrent(state: NamespaceState): Promise<void> {
  assertNamespaceAuthority(state)
  await assertRuntimeSpeechPackPurposeRootCurrent(state.root)
  const [openedRoot, namedRoot, names] = await Promise.all([
    state.rootHandle.stat({ bigint: true }),
    lstat(state.rootPath, { bigint: true }),
    readNames(state.rootPath, MAX_REGISTRY_DIRECTORY_CHILDREN)
  ])
  assertNamespaceAuthority(state)
  if (
    !sameRuntimeFileVersion(state.rootVersion, openedRoot) ||
    !sameRuntimeFileVersion(state.rootVersion, namedRoot) ||
    !exactMemberSet(state.children, names) ||
    names.some((name) => !(FIXED_MEMBERS as readonly string[]).includes(name))
  ) {
    state.retired = true
    state.frozen = true
    throw new Error('RUNTIME_REGISTRY_NAMESPACE_CHANGED')
  }
}

function assertNamespaceAuthority(state: NamespaceState): void {
  if (state.disposed || state.retired || state.frozen) throw new Error('RUNTIME_REGISTRY_NAMESPACE_RETIRED')
  state.assertKeyCurrentSync()
}

function physicalSnapshot(
  state: NamespaceState,
  versions: ReadonlyMap<string, BigIntStats>
): RuntimePhysicalSnapshotInput {
  const nodes = [{ path: state.rootPath, version: state.rootVersion }]
  for (const [member, version] of versions) nodes.push({ path: join(state.rootPath, member), version })
  return {
    roots: [{ path: state.rootPath, identity: state.rootVersion }],
    nodes,
    directories: [{ path: state.rootPath, version: state.rootVersion, children: [...state.children] }]
  }
}

async function capturePhysicalSnapshot(state: NamespaceState): Promise<{
  snapshot: RuntimePhysicalSnapshotInput
  versions: Map<string, BigIntStats>
}> {
  await assertNamespaceCurrent(state)
  const names = await readNames(state.rootPath, MAX_REGISTRY_DIRECTORY_CHILDREN)
  if (names.some((name) => !(FIXED_MEMBERS as readonly string[]).includes(name))) {
    throw new Error('RUNTIME_REGISTRY_UNKNOWN_MEMBER')
  }
  const versions = new Map<string, BigIntStats>()
  for (const name of names) {
    const version = await lstat(join(state.rootPath, name), { bigint: true })
    if (!version.isFile() || version.isSymbolicLink() || version.nlink !== 1n) {
      throw new Error('RUNTIME_REGISTRY_MEMBER_INVALID')
    }
    if (version.size < 0n || version.size > BigInt(MAX_REGISTRY_FRAME_BYTES)) {
      throw new Error('RUNTIME_REGISTRY_FRAME_LIMIT')
    }
    versions.set(name, version)
  }
  state.children = [...names]
  state.rootVersion = await lstat(state.rootPath, { bigint: true })
  return { snapshot: physicalSnapshot(state, versions), versions }
}

export async function openRuntimeRegistryNamespace(
  root: RuntimeSpeechPackPurposeRoot,
  input: { readonly keyId: string; readonly assertKeyCurrentSync: () => void }
): Promise<RuntimeRegistryNamespace> {
  if (!/^[a-f0-9]{64}$/.test(input.keyId)) throw new Error('RUNTIME_REGISTRY_KEY_ID_INVALID')
  await assertRuntimeSpeechPackPurposeRootCurrent(root)
  const description = describeRuntimeSpeechPackPurposeRoot(root)
  const names = await readNames(description.rootPath, MAX_REGISTRY_DIRECTORY_CHILDREN)
  if (names.some((name) => !(FIXED_MEMBERS as readonly string[]).includes(name))) {
    throw new Error('RUNTIME_REGISTRY_UNKNOWN_MEMBER')
  }
  const [rootVersion, canonical] = await Promise.all([
    lstat(description.rootPath, { bigint: true }),
    realpath(description.rootPath)
  ])
  if (!rootVersion.isDirectory() || rootVersion.isSymbolicLink() || canonical !== description.rootPath) {
    throw new Error('RUNTIME_REGISTRY_ROOT_INVALID')
  }
  const rootHandle = await open(
    description.rootPath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW | NONBLOCK
  )
  try {
    const [openedRoot, namedRoot, namesAfter] = await Promise.all([
      rootHandle.stat({ bigint: true }),
      lstat(description.rootPath, { bigint: true }),
      readNames(description.rootPath, MAX_REGISTRY_DIRECTORY_CHILDREN)
    ])
    input.assertKeyCurrentSync()
    await assertRuntimeSpeechPackPurposeRootCurrent(root)
    if (
      !sameRuntimeFileVersion(rootVersion, openedRoot) ||
      !sameRuntimeFileVersion(rootVersion, namedRoot) ||
      !exactMemberSet(names, namesAfter)
    ) {
      throw new Error('RUNTIME_REGISTRY_ROOT_CHANGED')
    }
    const state: NamespaceState = {
      root,
      rootPath: description.rootPath,
      rootBinding: description.bindingId,
      profile: description.profile,
      rootOwner: description.rootOwner,
      keyId: input.keyId,
      assertKeyCurrentSync: input.assertKeyCurrentSync,
      rootVersion,
      children: [...names],
      rootHandle,
      handles: new Set([rootHandle]),
      candidates: new Set(),
      disposed: false,
      retired: false,
      frozen: false,
      writing: false
    }
    const captured = await capturePhysicalSnapshot(state)
    const physical = await prepareRuntimePhysicalAdmission(captured.snapshot)
    try {
      input.assertKeyCurrentSync()
      physical.assertCurrentSync()
    } finally {
      await physical.dispose()
    }
    const namespace = Object.freeze({}) as RuntimeRegistryNamespace
    namespaces.set(namespace, state)
    return namespace
  } catch (error) {
    await rootHandle.close().catch(() => undefined)
    throw error
  }
}

export async function readRuntimeRegistryCandidate(
  namespace: RuntimeRegistryNamespace,
  slot: RegistrySlot
): Promise<null | Readonly<{
  candidate: RuntimeRegistryCandidate
  bytes: Uint8Array
  createdOwner: RuntimeStableFileOwner
}>> {
  const state = namespaces.get(namespace as object)
  if (!state) throw new Error('RUNTIME_REGISTRY_NAMESPACE_INVALID')
  const member = memberForSlot(slot)
  await assertNamespaceCurrent(state)
  const version = await lstat(join(state.rootPath, member), { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!version) return null
  if (!version.isFile() || version.isSymbolicLink() || version.nlink !== 1n || version.size < 0n) {
    throw new Error('RUNTIME_REGISTRY_CANDIDATE_INVALID')
  }
  if (version.size > BigInt(MAX_REGISTRY_FRAME_BYTES)) throw new Error('RUNTIME_REGISTRY_FRAME_LIMIT')
  const path = join(state.rootPath, member)
  const file = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  state.handles.add(file)
  try {
    const [openedBefore, namedBefore] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })])
    if (
      !sameRuntimeFileVersion(version, openedBefore) ||
      !sameRuntimeFileVersion(version, namedBefore) ||
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n
    ) {
      throw new Error('RUNTIME_REGISTRY_CANDIDATE_CHANGED')
    }
    const bytes = await boundedRead(file, Number(openedBefore.size))
    const [openedAfter, namedAfter] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })])
    await assertNamespaceCurrent(state)
    if (!sameRuntimeFileVersion(openedBefore, openedAfter) || !sameRuntimeFileVersion(openedBefore, namedAfter)) {
      throw new Error('RUNTIME_REGISTRY_CANDIDATE_CHANGED')
    }
    const candidateState: CandidateState = {
      namespace: state,
      member,
      path,
      bytes: Buffer.from(bytes),
      owner: ownerRecord(openedAfter),
      version: openedAfter,
      file,
      disposed: false,
      admitted: false
    }
    state.candidates.add(candidateState)
    const candidate = Object.freeze({}) as RuntimeRegistryCandidate
    candidates.set(candidate, candidateState)
    return Object.freeze({ candidate, bytes: Uint8Array.from(bytes), createdOwner: candidateState.owner })
  } catch (error) {
    state.handles.delete(file)
    await file.close().catch(() => undefined)
    throw error
  }
}

export async function readRuntimeRegistryPendingCandidate(
  namespace: RuntimeRegistryNamespace
): Promise<null | Readonly<{
  candidate: RuntimeRegistryCandidate
  bytes: Uint8Array
  createdOwner: RuntimeStableFileOwner
}>> {
  const state = namespaces.get(namespace as object)
  if (!state) throw new Error('RUNTIME_REGISTRY_NAMESPACE_INVALID')
  const member = 'registry.pending.v1'
  await assertNamespaceCurrent(state)
  const version = await lstat(join(state.rootPath, member), { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!version) return null
  if (!version.isFile() || version.isSymbolicLink() || version.nlink !== 1n || version.size < 0n) {
    throw new Error('RUNTIME_REGISTRY_CANDIDATE_INVALID')
  }
  if (version.size > BigInt(MAX_REGISTRY_FRAME_BYTES)) throw new Error('RUNTIME_REGISTRY_FRAME_LIMIT')
  const path = join(state.rootPath, member)
  const file = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  state.handles.add(file)
  try {
    const openedBefore = await file.stat({ bigint: true })
    const namedBefore = await lstat(path, { bigint: true })
    if (!sameRuntimeFileVersion(version, openedBefore) || !sameRuntimeFileVersion(version, namedBefore)) {
      throw new Error('RUNTIME_REGISTRY_CANDIDATE_CHANGED')
    }
    const bytes = await boundedRead(file, Number(openedBefore.size))
    const [openedAfter, namedAfter] = await Promise.all([file.stat({ bigint: true }), lstat(path, { bigint: true })])
    await assertNamespaceCurrent(state)
    if (!sameRuntimeFileVersion(openedBefore, openedAfter) || !sameRuntimeFileVersion(openedBefore, namedAfter)) {
      throw new Error('RUNTIME_REGISTRY_CANDIDATE_CHANGED')
    }
    const candidateState: CandidateState = {
      namespace: state,
      member,
      path,
      bytes: Buffer.from(bytes),
      owner: ownerRecord(openedAfter),
      version: openedAfter,
      file,
      disposed: false,
      admitted: false
    }
    state.candidates.add(candidateState)
    const candidate = Object.freeze({}) as RuntimeRegistryCandidate
    candidates.set(candidate, candidateState)
    return Object.freeze({ candidate, bytes: Uint8Array.from(bytes), createdOwner: candidateState.owner })
  } catch (error) {
    state.handles.delete(file)
    await file.close().catch(() => undefined)
    throw error
  }
}

async function revalidateCandidate(candidate: CandidateState): Promise<void> {
  const state = candidate.namespace
  assertNamespaceAuthority(state)
  await assertNamespaceCurrent(state)
  const [opened, named] = await Promise.all([
    candidate.file.stat({ bigint: true }),
    lstat(candidate.path, { bigint: true })
  ])
  if (
    !sameRuntimeFileVersion(candidate.version, opened) ||
    !sameRuntimeFileVersion(candidate.version, named) ||
    !sameFileOwner(candidate.owner, opened) ||
    !sameFileOwner(candidate.owner, named)
  ) {
    state.retired = true
    state.frozen = true
    throw new Error('RUNTIME_REGISTRY_CANDIDATE_CHANGED')
  }
}

export function createRuntimeRegistryRecordIssuer(
  namespace: RuntimeRegistryNamespace,
  input: { readonly keyId: string; readonly rootBinding: string; readonly assertKeyCurrentSync: () => void }
): {
  admitCandidate(
    candidate: RuntimeRegistryCandidate,
    authenticatedPublication: RuntimeRegistryPublicationBinding
  ): Promise<RuntimeOwnedRegistrySlot>
  admitPendingCandidate(
    candidate: RuntimeRegistryCandidate,
    authenticatedPublication: RuntimeRegistryPublicationBinding
  ): Promise<RuntimeRegistryScratch>
  retire(): void
} {
  const owner = namespaces.get(namespace as object)
  if (
    !owner ||
    owner.disposed ||
    owner.retired ||
    input.keyId !== owner.keyId ||
    input.rootBinding !== owner.rootBinding
  ) {
    throw new Error('RUNTIME_REGISTRY_ISSUER_BINDING_INVALID')
  }
  owner.assertKeyCurrentSync()
  let retired = false
  const state: RecordIssuerState = {
    namespace: owner,
    keyId: input.keyId,
    rootBinding: input.rootBinding,
    assertKeyCurrentSync: input.assertKeyCurrentSync,
    retired
  }
  const issuer = Object.freeze({
    async admitCandidate(
      candidate: RuntimeRegistryCandidate,
      authenticatedPublication: RuntimeRegistryPublicationBinding
    ): Promise<RuntimeOwnedRegistrySlot> {
      if (retired || state.retired) throw new Error('RUNTIME_REGISTRY_ISSUER_RETIRED')
      state.assertKeyCurrentSync()
      const candidateState = candidates.get(candidate as object)
      if (!candidateState || candidateState.namespace !== owner || candidateState.disposed || candidateState.admitted) {
        throw new Error('RUNTIME_REGISTRY_CANDIDATE_INVALID')
      }
      if (candidateState.member === 'registry.pending.v1') throw new Error('RUNTIME_REGISTRY_CANDIDATE_KIND_INVALID')
      validatePublication(owner, authenticatedPublication, candidateState)
      await revalidateCandidate(candidateState)
      state.assertKeyCurrentSync()
      candidateState.admitted = true
      const tokenState: SlotState = {
        namespace: owner,
        slot: authenticatedPublication.slot,
        owner: candidateState.owner,
        digest: createHash('sha256').update(candidateState.bytes).digest('hex'),
        version: candidateState.version,
        stale: false
      }
      const token = Object.freeze({}) as RuntimeOwnedRegistrySlot
      slots.set(token, tokenState)
      return token
    },
    async admitPendingCandidate(
      candidate: RuntimeRegistryCandidate,
      authenticatedPublication: RuntimeRegistryPublicationBinding
    ): Promise<RuntimeRegistryScratch> {
      if (retired || state.retired) throw new Error('RUNTIME_REGISTRY_ISSUER_RETIRED')
      state.assertKeyCurrentSync()
      const candidateState = candidates.get(candidate as object)
      if (
        !candidateState ||
        candidateState.namespace !== owner ||
        candidateState.member !== 'registry.pending.v1' ||
        candidateState.disposed ||
        candidateState.admitted
      ) {
        throw new Error('RUNTIME_REGISTRY_CANDIDATE_INVALID')
      }
      validatePublication(owner, authenticatedPublication, candidateState)
      await revalidateCandidate(candidateState)
      state.assertKeyCurrentSync()
      candidateState.admitted = true
      const scratchState: ScratchState = {
        namespace: owner,
        publication: Object.freeze({ ...authenticatedPublication }),
        owner: candidateState.owner,
        version: candidateState.version,
        digest: createHash('sha256').update(candidateState.bytes).digest('hex'),
        ciphertext: Buffer.from(candidateState.bytes),
        fromPendingCandidate: true,
        consumed: false
      }
      const token = Object.freeze({}) as RuntimeRegistryScratch
      scratches.set(token, scratchState)
      return token
    },
    retire(): void {
      if (retired) return
      retired = true
      state.retired = true
    }
  })
  issuers.set(issuer, state)
  return issuer
}

export async function beginRuntimeRegistrySlotWrite(
  namespace: RuntimeRegistryNamespace,
  slot: RegistrySlot,
  expected: RuntimeOwnedRegistrySlot | null
): Promise<
  Readonly<{
    publication: RuntimeRegistryPublicationBinding
    finish(ciphertext: Uint8Array): Promise<RuntimeRegistryScratch>
    dispose(): Promise<void>
  }>
> {
  const state = namespaces.get(namespace as object)
  if (!state) throw new Error('RUNTIME_REGISTRY_NAMESPACE_INVALID')
  assertNamespaceAuthority(state)
  if (state.writing) throw new Error('RUNTIME_REGISTRY_WRITE_ALREADY_ACTIVE')
  const expectedState = expected ? slots.get(expected as object) : null
  if (expected && (!expectedState || expectedState.namespace !== state || expectedState.stale)) {
    throw new Error('RUNTIME_REGISTRY_EXPECTED_SLOT_INVALID')
  }
  const member = memberForSlot(slot)
  const publicationId = randomUUID()
  await assertNamespaceCurrent(state)
  if (state.children.includes('registry.pending.v1')) throw new Error('RUNTIME_REGISTRY_PENDING_EXISTS')
  const path = join(state.rootPath, 'registry.pending.v1')
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NONBLOCK,
    0o600
  )
  state.handles.add(handle)
  state.writing = true
  let closed = false
  let active = true
  let currentVersion: BigIntStats
  let createdOwner: RuntimeStableFileOwner
  try {
    const rootImmediately = readRuntimeNamedVersionSync(state.rootPath)
    const namesImmediately = readRuntimeDirectoryNamesSync(state.rootPath, MAX_REGISTRY_DIRECTORY_CHILDREN)
    if (
      !sameOwner(state.rootOwner, rootImmediately) ||
      !exactMemberSet([...state.children, 'registry.pending.v1'], namesImmediately)
    ) {
      state.frozen = true
      throw new Error('RUNTIME_REGISTRY_PARENT_CHANGED')
    }
    state.rootVersion = rootImmediately
    state.children = [...namesImmediately]
    const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    if (!sameRuntimeFileVersion(opened, named) || !opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) {
      state.frozen = true
      throw new Error('RUNTIME_REGISTRY_SCRATCH_UNCONFIRMED')
    }
    currentVersion = opened
    createdOwner = ownerRecord(opened)
    const [openedRoot, namedRoot, namesAfter] = await Promise.all([
      state.rootHandle.stat({ bigint: true }),
      lstat(state.rootPath, { bigint: true }),
      readNames(state.rootPath, MAX_REGISTRY_DIRECTORY_CHILDREN)
    ])
    if (
      !sameRuntimeFileVersion(rootImmediately, openedRoot) ||
      !sameRuntimeFileVersion(rootImmediately, namedRoot) ||
      !exactMemberSet(namesImmediately, namesAfter)
    ) {
      state.frozen = true
      throw new Error('RUNTIME_REGISTRY_PARENT_CHANGED')
    }
  } catch (error) {
    state.frozen = true
    state.writing = false
    throw error
  }
  const publication: RuntimeRegistryPublicationBinding = Object.freeze({
    schemaVersion: 1,
    purpose: 'metis-speech-pack-registry-slot/v1',
    rootBinding: state.rootBinding,
    keyId: state.keyId,
    slot,
    publicationId,
    createdOwner,
    replacesDigest: expectedState?.digest ?? null
  })
  const dispose = async (): Promise<void> => {
    if (!active) return
    active = false
    if (!closed) {
      closed = true
      await handle.close().catch(() => undefined)
    }
    state.writing = false
  }
  return Object.freeze({
    publication,
    async finish(ciphertext: Uint8Array): Promise<RuntimeRegistryScratch> {
      if (!active || closed) throw new Error('RUNTIME_REGISTRY_WRITER_CLOSED')
      if (ciphertext.byteLength > MAX_REGISTRY_FRAME_BYTES) throw new Error('RUNTIME_REGISTRY_FRAME_LIMIT')
      const bytes = Buffer.from(ciphertext)
      try {
        await assertNamespaceCurrent(state)
        const before = await handle.stat({ bigint: true })
        const namedBefore = await lstat(path, { bigint: true })
        if (!sameRuntimeFileVersion(currentVersion, before) || !sameRuntimeFileVersion(currentVersion, namedBefore)) {
          throw new Error('RUNTIME_REGISTRY_SCRATCH_CHANGED')
        }
        let offset = 0
        while (offset < bytes.byteLength) {
          state.assertKeyCurrentSync()
          const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset)
          if (result.bytesWritten <= 0) throw new Error('RUNTIME_REGISTRY_WRITE_ZERO_PROGRESS')
          offset += result.bytesWritten
          const afterWrite = await handle.stat({ bigint: true })
          const namedAfterWrite = await lstat(path, { bigint: true })
          if (
            !sameRuntimeFileVersion(currentVersion, afterWrite) ||
            !sameRuntimeFileVersion(currentVersion, namedAfterWrite) ||
            afterWrite.size !== BigInt(offset)
          ) {
            throw new Error('RUNTIME_REGISTRY_SCRATCH_CHANGED')
          }
          currentVersion = afterWrite
        }
        await handle.sync()
        const beforeClose = await handle.stat({ bigint: true })
        const namedBeforeClose = await lstat(path, { bigint: true })
        if (
          !sameRuntimeFileVersion(currentVersion, beforeClose) ||
          !sameRuntimeFileVersion(currentVersion, namedBeforeClose)
        ) {
          throw new Error('RUNTIME_REGISTRY_SCRATCH_CHANGED')
        }
        await handle.close()
        closed = true
        const closedNamed = await lstat(path, { bigint: true })
        if (!sameRuntimeFileVersion(beforeClose, closedNamed)) throw new Error('RUNTIME_REGISTRY_SCRATCH_CHANGED')
        currentVersion = beforeClose
        const scratchState: ScratchState = {
          namespace: state,
          publication,
          owner: createdOwner,
          version: currentVersion,
          digest: createHash('sha256').update(bytes).digest('hex'),
          ciphertext: bytes,
          fromPendingCandidate: false,
          consumed: false
        }
        const scratch = Object.freeze({}) as RuntimeRegistryScratch
        scratches.set(scratch, scratchState)
        state.writing = false
        active = false
        return scratch
      } catch (error) {
        state.frozen = true
        throw error
      }
    },
    dispose
  })
}

export async function prepareRuntimeRegistryReplace(input: {
  readonly namespace: RuntimeRegistryNamespace
  readonly scratch: RuntimeRegistryScratch
  readonly expected: RuntimeOwnedRegistrySlot | null
}): Promise<RuntimeRegistryReplaceAdmission> {
  const namespace = namespaces.get(input.namespace as object)
  const scratch = scratches.get(input.scratch as object)
  if (!namespace || !scratch || scratch.namespace !== namespace || scratch.consumed || namespace.writing) {
    throw new Error('RUNTIME_REGISTRY_REPLACE_INVALID')
  }
  const expected = input.expected ? (slots.get(input.expected as object) ?? null) : null
  if (input.expected && (!expected || expected.namespace !== namespace || expected.stale)) {
    throw new Error('RUNTIME_REGISTRY_EXPECTED_SLOT_INVALID')
  }
  if (scratch.publication.replacesDigest !== (expected?.digest ?? null)) {
    throw new Error('RUNTIME_REGISTRY_REPLACEMENT_CHAIN_INVALID')
  }
  const destination = join(namespace.rootPath, memberForSlot(scratch.publication.slot))
  await assertNamespaceCurrent(namespace)
  const captured = await capturePhysicalSnapshot(namespace)
  const named = captured.versions.get(memberForSlot(scratch.publication.slot))
  if (expected) {
    if (!named || !sameRuntimeFileVersion(expected.version, named) || !sameFileOwner(expected.owner, named)) {
      throw new Error('RUNTIME_REGISTRY_TARGET_CHANGED')
    }
  } else if (named) {
    throw new Error('RUNTIME_REGISTRY_TARGET_EXISTS')
  }
  const pending = captured.versions.get('registry.pending.v1')
  if (!pending || !sameRuntimeFileVersion(scratch.version, pending) || !sameFileOwner(scratch.owner, pending)) {
    throw new Error('RUNTIME_REGISTRY_SCRATCH_CHANGED')
  }
  const physical = await prepareRuntimePhysicalAdmission(captured.snapshot)
  try {
    await assertNamespaceCurrent(namespace)
    namespace.assertKeyCurrentSync()
  } catch (error) {
    await physical.dispose()
    throw error
  }
  const state: ReplaceAdmissionState = {
    namespace,
    scratch,
    expected,
    destination,
    physical,
    childrenBefore: [...namespace.children],
    disposed: false,
    consumed: false
  }
  const admission = Object.freeze({}) as RuntimeRegistryReplaceAdmission
  replacements.set(admission, state)
  return admission
}

export function commitRuntimeRegistryReplace(admission: RuntimeRegistryReplaceAdmission): RuntimeRegistryRenameReceipt {
  const state = replacements.get(admission as object)
  if (!state || state.disposed || state.consumed) throw new Error('RUNTIME_REGISTRY_REPLACE_ADMISSION_INVALID')
  state.consumed = true
  const rename = Object.freeze({}) as RuntimeRegistryRenameReceipt
  const receiptState: RenameReceiptState = {
    admission: state,
    movedVersion: null,
    rootVersion: null,
    childrenAfter: null,
    settled: false,
    movedUnconfirmed: false
  }
  renameReceipts.set(rename, receiptState)
  try {
    renameRuntimeDirectorySyncAfterAdmission({
      admission: state.physical,
      source: join(state.namespace.rootPath, 'registry.pending.v1'),
      destination: state.destination,
      assertCallerCurrentSync: state.namespace.assertKeyCurrentSync
    })
    const moved = readRuntimeNamedVersionSync(state.destination)
    const root = readRuntimeNamedVersionSync(state.namespace.rootPath)
    const names = readRuntimeDirectoryNamesSync(state.namespace.rootPath, MAX_REGISTRY_DIRECTORY_CHILDREN)
    const expectedNames = state.childrenBefore
      .filter(
        (name) =>
          name !== 'registry.pending.v1' && name !== state.destination.slice(state.namespace.rootPath.length + 1)
      )
      .concat(state.destination.slice(state.namespace.rootPath.length + 1))
    if (
      !sameFileOwner(state.scratch.owner, moved) ||
      moved.size !== BigInt(state.scratch.ciphertext.byteLength) ||
      !sameOwner(state.namespace.rootOwner, root) ||
      !exactMemberSet(expectedNames, names)
    ) {
      receiptState.movedUnconfirmed = true
      state.namespace.frozen = true
      return rename
    }
    receiptState.movedVersion = moved
    receiptState.rootVersion = root
    receiptState.childrenAfter = [...names]
    state.namespace.rootVersion = root
    state.namespace.children = [...names]
    state.scratch.consumed = true
    if (state.expected) state.expected.stale = true
    return rename
  } catch {
    receiptState.movedUnconfirmed = true
    state.namespace.frozen = true
    return rename
  }
}

export async function settleRuntimeRegistryReplace(
  receipt: RuntimeRegistryRenameReceipt
): Promise<RuntimeOwnedRegistrySlot> {
  const state = renameReceipts.get(receipt as object)
  if (!state || state.settled) throw new Error('RUNTIME_REGISTRY_RENAME_RECEIPT_INVALID')
  state.settled = true
  const admission = state.admission
  const namespace = admission.namespace
  try {
    if (state.movedUnconfirmed || !state.movedVersion || !state.rootVersion || !state.childrenAfter) {
      throw new Error('RUNTIME_REGISTRY_MOVE_UNCONFIRMED')
    }
    namespace.assertKeyCurrentSync()
    await assertRuntimeSpeechPackPurposeRootCurrent(namespace.root)
    const handle = await open(state.admission.destination, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
    namespace.handles.add(handle)
    try {
      const [opened, named] = await Promise.all([
        handle.stat({ bigint: true }),
        lstat(state.admission.destination, { bigint: true })
      ])
      if (!sameRuntimeFileVersion(state.movedVersion, opened) || !sameRuntimeFileVersion(state.movedVersion, named)) {
        throw new Error('RUNTIME_REGISTRY_MOVE_READBACK_CHANGED')
      }
      const bytes = await boundedRead(handle, Number(opened.size))
      if (!bytes.equals(state.admission.scratch.ciphertext)) throw new Error('RUNTIME_REGISTRY_MOVE_READBACK_CHANGED')
      await handle.close()
      namespace.handles.delete(handle)
    } finally {
      await handle.close().catch(() => undefined)
      namespace.handles.delete(handle)
    }
    const rootHandle = await open(
      namespace.rootPath,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW | NONBLOCK
    )
    try {
      await rootHandle.sync()
    } finally {
      await rootHandle.close()
    }
    const [rootAfterSync, names] = await Promise.all([
      lstat(namespace.rootPath, { bigint: true }),
      readNames(namespace.rootPath, MAX_REGISTRY_DIRECTORY_CHILDREN)
    ])
    if (
      !sameOwner(namespace.rootOwner, rootAfterSync) ||
      !sameRuntimeFileVersion(state.rootVersion, rootAfterSync) ||
      !exactMemberSet(state.childrenAfter, names)
    ) {
      throw new Error('RUNTIME_REGISTRY_MOVE_SETTLEMENT_CHANGED')
    }
    await assertRuntimeSpeechPackPurposeRootCurrent(namespace.root)
    const slot = state.admission.scratch.publication.slot
    const tokenState: SlotState = {
      namespace,
      slot,
      owner: state.admission.scratch.owner,
      digest: state.admission.scratch.digest,
      version: state.movedVersion,
      stale: false
    }
    const token = Object.freeze({}) as RuntimeOwnedRegistrySlot
    slots.set(token, tokenState)
    return token
  } catch (error) {
    namespace.frozen = true
    throw error
  } finally {
    admission.disposed = true
    await admission.physical.dispose()
  }
}

export async function disposeRuntimeRegistryNamespace(namespace: RuntimeRegistryNamespace): Promise<void> {
  const state = namespaces.get(namespace as object)
  if (!state || state.disposed) return
  state.disposed = true
  state.frozen = true
  await Promise.allSettled([...state.handles].map((handle) => handle.close()))
  state.handles.clear()
}
