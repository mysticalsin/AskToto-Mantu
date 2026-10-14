import { createHash, timingSafeEqual } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import {
  createRuntimeExclusiveFileAfterAdmission,
  prepareRuntimeExclusiveFileCreation,
  prepareRuntimePhysicalAdmission,
  sameRuntimeFileVersion,
  type RuntimeExclusiveFileSink,
  type RuntimePhysicalSnapshotInput
} from './runtime-owned-files'
import {
  assertRuntimeSpeechPackPurposeRootCurrent,
  describeRuntimeSpeechPackPurposeRoot,
  prepareRuntimeSpeechPackPurposeRootAdmission,
  type RuntimeSpeechPackPurposeRoot,
  type RuntimeStableFileOwner,
  type RuntimeStableOwner
} from './runtime-purpose-root'

const KEY_MEMBER = 'key.v1'
const FIXED_MEMBERS = ['key.v1', 'registry.0.v1', 'registry.1.v1', 'registry.pending.v1'] as const
const MAX_KEY_ANCHOR_BYTES = 65_536
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
const NONBLOCK = constants.O_NONBLOCK ?? 0

declare const ownerBrand: unique symbol
declare const candidateBrand: unique symbol
declare const anchorBrand: unique symbol
export type RuntimeKeyAnchorOwner = { readonly [ownerBrand]: true }
export type RuntimeKeyAnchorCandidate = { readonly [candidateBrand]: true }
export type RuntimeKeyAnchor = { readonly [anchorBrand]: true }

interface OwnerState {
  readonly root: RuntimeSpeechPackPurposeRoot
  readonly path: string
  readonly rootHandle: FileHandle
  readonly rootOwner: RuntimeStableOwner
  readonly bindingId: string
  readonly fresh: boolean
  readonly assertCurrentSync: () => void
  readonly assertPhysicalCurrent: () => Promise<void>
  rootVersion: BigIntStats
  children: string[]
  readonly candidates: Set<CandidateState>
  disposed: boolean
  retired: boolean
}

interface CandidateState {
  readonly owner: OwnerState
  readonly path: string
  readonly handle: FileHandle
  readonly bytes: Buffer
  readonly ownerRecord: RuntimeStableFileOwner
  readonly version: BigIntStats
  disposed: boolean
  admitted: boolean
}

interface AnchorState {
  readonly owner: OwnerState
  readonly candidate: CandidateState
  readonly keyId: string
  readonly digest: string
  retired: boolean
}

const owners = new WeakMap<object, OwnerState>()
const candidates = new WeakMap<object, CandidateState>()
const anchors = new WeakMap<object, AnchorState>()

export async function openRuntimeKeyAnchorOwner(
  root: RuntimeSpeechPackPurposeRoot,
  input: {
    readonly assertCurrentSync: () => void
    readonly assertPhysicalCurrent: () => Promise<void>
  }
): Promise<RuntimeKeyAnchorOwner> {
  input.assertCurrentSync()
  await input.assertPhysicalCurrent()
  input.assertCurrentSync()
  await assertRuntimeSpeechPackPurposeRootCurrent(root)
  input.assertCurrentSync()
  const description = describeRuntimeSpeechPackPurposeRoot(root)
  if (description.rootPath.length === 0 || description.bindingId.length !== 64) {
    throw new Error('RUNTIME_KEY_ANCHOR_ROOT_INVALID')
  }
  const rootHandle = await open(
    description.rootPath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW | NONBLOCK
  )
  try {
    const [opened, named, openedAfter, canonical, children] = await Promise.all([
      rootHandle.stat({ bigint: true }),
      lstat(description.rootPath, { bigint: true }),
      rootHandle.stat({ bigint: true }),
      realpath(description.rootPath),
      readNames(description.rootPath)
    ])
    input.assertCurrentSync()
    await input.assertPhysicalCurrent()
    input.assertCurrentSync()
    await assertRuntimeSpeechPackPurposeRootCurrent(root)
    input.assertCurrentSync()
    if (
      canonical !== description.rootPath ||
      !sameRuntimeFileVersion(opened, named) ||
      !sameRuntimeFileVersion(opened, openedAfter) ||
      !sameStableDirectory(description.rootOwner, opened) ||
      !validMemberSet(children)
    ) {
      throw new Error('RUNTIME_KEY_ANCHOR_ROOT_CHANGED')
    }
    const token = Object.freeze({}) as RuntimeKeyAnchorOwner
    owners.set(token, {
      root,
      path: description.rootPath,
      rootHandle,
      rootOwner: description.rootOwner,
      bindingId: description.bindingId,
      fresh: description.fresh,
      assertCurrentSync: input.assertCurrentSync,
      assertPhysicalCurrent: input.assertPhysicalCurrent,
      rootVersion: opened,
      children,
      candidates: new Set(),
      disposed: false,
      retired: false
    })
    return token
  } catch (error) {
    await rootHandle.close().catch(() => undefined)
    throw error
  }
}

export async function readRuntimeKeyAnchorCandidate(owner: RuntimeKeyAnchorOwner): Promise<null | Readonly<{
  candidate: RuntimeKeyAnchorCandidate
  bytes: Uint8Array
  createdOwner: RuntimeStableFileOwner
}>> {
  const state = ownerState(owner)
  await refreshOwner(state)
  const path = join(state.path, KEY_MEMBER)
  const version = await lstat(path, { bigint: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  await refreshOwner(state)
  if (!version) return null
  if (!version.isFile() || version.isSymbolicLink() || version.nlink !== 1n || version.size < 1n) {
    throw new Error('RUNTIME_KEY_ANCHOR_CANDIDATE_INVALID')
  }
  if (version.size > BigInt(MAX_KEY_ANCHOR_BYTES)) throw new Error('RUNTIME_KEY_ANCHOR_LIMIT')
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
  try {
    const [openedBefore, namedBefore] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true })
    ])
    await refreshOwner(state)
    if (
      !sameRuntimeFileVersion(version, openedBefore) ||
      !sameRuntimeFileVersion(version, namedBefore) ||
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n
    ) {
      throw new Error('RUNTIME_KEY_ANCHOR_CANDIDATE_CHANGED')
    }
    const bytes = await boundedRead(handle, Number(openedBefore.size))
    const [openedAfter, namedAfter] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })])
    await refreshOwner(state)
    if (!sameRuntimeFileVersion(openedBefore, openedAfter) || !sameRuntimeFileVersion(openedBefore, namedAfter)) {
      throw new Error('RUNTIME_KEY_ANCHOR_CANDIDATE_CHANGED')
    }
    const candidateState: CandidateState = {
      owner: state,
      path,
      handle,
      bytes: Buffer.from(bytes),
      ownerRecord: fileOwner(openedAfter),
      version: openedAfter,
      disposed: false,
      admitted: false
    }
    state.candidates.add(candidateState)
    const candidate = Object.freeze({}) as RuntimeKeyAnchorCandidate
    candidates.set(candidate, candidateState)
    return Object.freeze({ candidate, bytes: Uint8Array.from(bytes), createdOwner: candidateState.ownerRecord })
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export async function admitRuntimeKeyAnchorCandidate(
  owner: RuntimeKeyAnchorOwner,
  candidate: RuntimeKeyAnchorCandidate,
  authenticatedKeyId: string,
  authenticatedBytes: Uint8Array
): Promise<RuntimeKeyAnchor> {
  const state = ownerState(owner)
  const candidateState = candidates.get(candidate as object)
  if (
    !candidateState ||
    candidateState.owner !== state ||
    candidateState.disposed ||
    candidateState.admitted ||
    !/^[a-f0-9]{64}$/.test(authenticatedKeyId) ||
    !sameBytes(candidateState.bytes, authenticatedBytes)
  ) {
    throw new Error('RUNTIME_KEY_ANCHOR_CANDIDATE_INVALID')
  }
  await refreshOwner(state)
  await assertCandidateCurrent(candidateState)
  candidateState.admitted = true
  return issueAnchor(state, candidateState, authenticatedKeyId)
}

export async function createRuntimeKeyAnchor(
  owner: RuntimeKeyAnchorOwner,
  keyBytes: Uint8Array,
  keyId: string
): Promise<RuntimeKeyAnchor> {
  const state = ownerState(owner)
  const bytes = Buffer.from(keyBytes)
  if (
    !state.fresh ||
    state.children.length !== 0 ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_KEY_ANCHOR_BYTES ||
    !/^[a-f0-9]{64}$/.test(keyId)
  ) {
    throw new Error('RUNTIME_KEY_ANCHOR_CREATE_NOT_ALLOWED')
  }
  await refreshOwner(state)
  if (state.children.length !== 0) throw new Error('RUNTIME_KEY_ANCHOR_CREATE_NOT_ALLOWED')
  const parentAdmission = await prepareRuntimeSpeechPackPurposeRootAdmission(state.root)
  const snapshot = rootSnapshot(state)
  const creationAdmission = await prepareRuntimeExclusiveFileCreation({
    path: join(state.path, KEY_MEMBER),
    parentPath: state.path,
    snapshot
  })
  let sink: RuntimeExclusiveFileSink | null = null
  try {
    assertOwnerAuthority(state)
    parentAdmission.assertCurrentSync()
    const creation = await createRuntimeExclusiveFileAfterAdmission(creationAdmission, MAX_KEY_ANCHOR_BYTES, () => {
      assertOwnerAuthority(state)
      parentAdmission.assertCurrentSync()
    })
    sink = creation.sink
    if (creation.receipt.status !== 'created') throw new Error('RUNTIME_KEY_ANCHOR_CREATE_UNCONFIRMED')
    await sink.write(bytes)
    await sink.sync()
    const closed = await sink.close()
    sink = null
    if (closed.status !== 'created') throw new Error('RUNTIME_KEY_ANCHOR_CREATE_UNCONFIRMED')
    await state.rootHandle.sync()
    await updateAfterOwnCreate(state, closed.version)
    const readback = await readRuntimeKeyAnchorCandidate(owner)
    if (!readback || !sameBytes(Buffer.from(readback.bytes), bytes)) {
      throw new Error('RUNTIME_KEY_ANCHOR_READBACK_FAILED')
    }
    const anchor = await admitRuntimeKeyAnchorCandidate(owner, readback.candidate, keyId, bytes)
    return anchor
  } catch (error) {
    if (sink) await sink.close().catch(() => undefined)
    state.retired = true
    throw error
  } finally {
    await parentAdmission.dispose().catch(() => undefined)
  }
}

export function describeRuntimeKeyAnchor(anchor: RuntimeKeyAnchor): Readonly<{
  rootBinding: string
  keyId: string
  createdOwner: RuntimeStableFileOwner
  digest: string
  byteLength: number
}> {
  const state = anchorState(anchor)
  return Object.freeze({
    rootBinding: state.owner.bindingId,
    keyId: state.keyId,
    createdOwner: state.candidate.ownerRecord,
    digest: state.digest,
    byteLength: state.candidate.bytes.byteLength
  })
}

export function assertRuntimeKeyAnchorCurrentSync(anchor: RuntimeKeyAnchor): void {
  const state = anchorState(anchor)
  assertOwnerAuthority(state.owner)
  if (state.retired || state.candidate.disposed) throw new Error('RUNTIME_KEY_ANCHOR_RETIRED')
}

export async function assertRuntimeKeyAnchorCurrent(anchor: RuntimeKeyAnchor): Promise<void> {
  const state = anchorState(anchor)
  await refreshOwner(state.owner)
  await assertCandidateCurrent(state.candidate)
}

export async function disposeRuntimeKeyAnchorOwner(owner: RuntimeKeyAnchorOwner): Promise<void> {
  const state = owners.get(owner as object)
  if (!state || state.disposed) return
  state.disposed = true
  state.retired = true
  const results = await Promise.allSettled([...state.candidates].map((candidate) => closeCandidate(candidate)))
  await state.rootHandle.close().catch(() => undefined)
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, 'RUNTIME_KEY_ANCHOR_DISPOSAL_FAILED')
}

function issueAnchor(owner: OwnerState, candidate: CandidateState, keyId: string): RuntimeKeyAnchor {
  const anchor = Object.freeze({}) as RuntimeKeyAnchor
  anchors.set(anchor, {
    owner,
    candidate,
    keyId,
    digest: createHash('sha256').update(candidate.bytes).digest('hex'),
    retired: false
  })
  return anchor
}

function ownerState(owner: RuntimeKeyAnchorOwner): OwnerState {
  const state = owners.get(owner as object)
  if (!state) throw new Error('RUNTIME_KEY_ANCHOR_OWNER_INVALID')
  assertOwnerAuthority(state)
  return state
}

function anchorState(anchor: RuntimeKeyAnchor): AnchorState {
  const state = anchors.get(anchor as object)
  if (!state) throw new Error('RUNTIME_KEY_ANCHOR_INVALID')
  assertOwnerAuthority(state.owner)
  if (state.retired || state.candidate.disposed || !state.candidate.admitted) {
    throw new Error('RUNTIME_KEY_ANCHOR_RETIRED')
  }
  return state
}

function assertOwnerAuthority(state: OwnerState): void {
  if (state.disposed || state.retired) throw new Error('RUNTIME_KEY_ANCHOR_OWNER_RETIRED')
  state.assertCurrentSync()
}

async function refreshOwner(state: OwnerState): Promise<void> {
  assertOwnerAuthority(state)
  await state.assertPhysicalCurrent()
  assertOwnerAuthority(state)
  await assertRuntimeSpeechPackPurposeRootCurrent(state.root)
  assertOwnerAuthority(state)
  const [opened, named, canonical, children] = await Promise.all([
    state.rootHandle.stat({ bigint: true }),
    lstat(state.path, { bigint: true }),
    realpath(state.path),
    readNames(state.path)
  ])
  assertOwnerAuthority(state)
  if (
    canonical !== state.path ||
    !sameStableDirectory(state.rootOwner, opened) ||
    !sameRuntimeFileVersion(opened, named) ||
    !validMemberSet(children)
  ) {
    state.retired = true
    throw new Error('RUNTIME_KEY_ANCHOR_ROOT_CHANGED')
  }
  state.rootVersion = opened
  state.children = children
}

async function assertCandidateCurrent(candidate: CandidateState): Promise<void> {
  if (candidate.disposed || candidate.owner.disposed || candidate.owner.retired) {
    throw new Error('RUNTIME_KEY_ANCHOR_CANDIDATE_RETIRED')
  }
  const [opened, named] = await Promise.all([
    candidate.handle.stat({ bigint: true }),
    lstat(candidate.path, { bigint: true })
  ])
  assertOwnerAuthority(candidate.owner)
  await assertRuntimeSpeechPackPurposeRootCurrent(candidate.owner.root)
  assertOwnerAuthority(candidate.owner)
  if (!sameRuntimeFileVersion(candidate.version, opened) || !sameRuntimeFileVersion(candidate.version, named)) {
    candidate.owner.retired = true
    throw new Error('RUNTIME_KEY_ANCHOR_CHANGED')
  }
}

async function updateAfterOwnCreate(state: OwnerState, created: BigIntStats): Promise<void> {
  const [openedRoot, namedRoot, keyVersion, children] = await Promise.all([
    state.rootHandle.stat({ bigint: true }),
    lstat(state.path, { bigint: true }),
    lstat(join(state.path, KEY_MEMBER), { bigint: true }),
    readNames(state.path)
  ])
  assertOwnerAuthority(state)
  if (
    !sameStableDirectory(state.rootOwner, openedRoot) ||
    !sameRuntimeFileVersion(openedRoot, namedRoot) ||
    !sameRuntimeFileVersion(created, keyVersion) ||
    !exactNames([...state.children, KEY_MEMBER], children)
  ) {
    state.retired = true
    throw new Error('RUNTIME_KEY_ANCHOR_CREATE_UNCONFIRMED')
  }
  state.rootVersion = openedRoot
  state.children = children
}

function rootSnapshot(state: OwnerState): RuntimePhysicalSnapshotInput {
  return {
    roots: [{ path: state.path, identity: state.rootVersion }],
    nodes: [{ path: state.path, version: state.rootVersion }],
    directories: [{ path: state.path, version: state.rootVersion, children: [...state.children] }]
  }
}

async function readNames(path: string): Promise<string[]> {
  const directory = await opendir(path, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = await directory.read()
      if (!entry) return names
      if (names.length >= FIXED_MEMBERS.length) throw new Error('RUNTIME_KEY_ANCHOR_MEMBER_LIMIT')
      names.push(entry.name)
    }
  } finally {
    await directory.close()
  }
}

function validMemberSet(names: readonly string[]): boolean {
  return (
    names.every((name) => (FIXED_MEMBERS as readonly string[]).includes(name)) && new Set(names).size === names.length
  )
}

async function boundedRead(handle: FileHandle, expectedBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_KEY_ANCHOR_BYTES) {
    throw new Error('RUNTIME_KEY_ANCHOR_LIMIT')
  }
  const buffer = Buffer.alloc(expectedBytes + 1)
  let offset = 0
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset !== expectedBytes) throw new Error('RUNTIME_KEY_ANCHOR_LENGTH_CHANGED')
  return Buffer.from(buffer.subarray(0, expectedBytes))
}

function fileOwner(version: BigIntStats): RuntimeStableFileOwner {
  if (!version.isFile() || version.isSymbolicLink() || version.nlink !== 1n) {
    throw new Error('RUNTIME_KEY_ANCHOR_FILE_INVALID')
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

function sameStableDirectory(expected: RuntimeStableOwner, actual: BigIntStats): boolean {
  return (
    actual.isDirectory() &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev.toString() &&
    expected.ino === actual.ino.toString() &&
    expected.birthtimeNs === actual.birthtimeNs.toString() &&
    expected.mode === actual.mode.toString() &&
    expected.uid === actual.uid.toString() &&
    expected.gid === actual.gid.toString() &&
    expected.rdev === actual.rdev.toString()
  )
}

function exactNames(expected: readonly string[], actual: readonly string[]): boolean {
  return [...expected].sort().join('\0') === [...actual].sort().join('\0')
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

async function closeCandidate(candidate: CandidateState): Promise<void> {
  if (candidate.disposed) return
  candidate.disposed = true
  candidate.owner.candidates.delete(candidate)
  candidate.bytes.fill(0)
  await candidate.handle.close()
}
