import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RuntimeDirectoryCreationReceipt } from './runtime-owned-files'
import type { RuntimePhysicalSnapshotInput } from './runtime-owned-files'
import {
  runtimePayloadPlanBudget,
  runtimePayloadPlanFileClaims,
  runtimePayloadPlanIdentity,
  runtimePayloadPlanRoot,
  type RuntimePayloadWritePlan
} from './runtime-payload-plan'

const MAX_TREE_NODES = 4096
const MAX_TREE_PATH_BYTES = 4 * 1024 * 1024
declare const authenticatedRuntimeOwnedTreeRecord: unique symbol
declare const authenticatedRuntimeOwnedTreeMoveIntent: unique symbol

export interface RuntimeOwnedTreeIdentity {
  readonly dev: string
  readonly ino: string
  readonly mode: string
  readonly nlink: string
  readonly uid: string
  readonly gid: string
  readonly rdev: string
  readonly size: string
  readonly blocks: string
  readonly mtimeNs: string
  readonly ctimeNs: string
  readonly birthtimeNs: string
}

export type RuntimeOwnedTreeEntry =
  | {
      readonly path: string
      readonly kind: 'directory'
      readonly identity: RuntimeOwnedTreeIdentity
      readonly children: readonly string[]
    }
  | {
      readonly path: string
      readonly kind: 'file'
      readonly identity: RuntimeOwnedTreeIdentity
      readonly sha256: string
    }

export interface RuntimeOwnedTreeManifest {
  readonly schemaVersion: 2
  readonly root: RuntimeOwnedTreeIdentity
  readonly rootParent: RuntimeOwnedTreeIdentity
  readonly entries: readonly RuntimeOwnedTreeEntry[]
}

export interface RuntimeOwnedTreeRecordBinding {
  readonly purpose: 'metis-speech-pack-owner-key/v1'
  readonly schemaVersion: 2
  readonly profileBinding: string
  readonly principalBinding: string
  readonly rootBinding: string
  readonly rootPath: string
}

export interface RuntimeOwnedTreeAuthenticatedInput extends RuntimeOwnedTreeRecordBinding {
  readonly manifest: RuntimeOwnedTreeManifest
}

export interface AuthenticatedRuntimeOwnedTreeRecord {
  readonly [authenticatedRuntimeOwnedTreeRecord]: true
}

export interface RuntimeOwnedTreeRecordIssuer {
  issue(record: RuntimeOwnedTreeAuthenticatedInput): AuthenticatedRuntimeOwnedTreeRecord
  retire(): void
}

export interface RuntimeRecordedTreeParent {
  readonly relativePath: string
  readonly identity: RuntimeOwnedTreeIdentity
  readonly children: readonly string[]
}

export interface RuntimeOwnedTreeMoveAuthenticatedInput {
  readonly schemaVersion: 1
  readonly operation: 'tree-move'
  readonly purpose: 'metis-speech-pack-owner-key/v1'
  readonly profileBinding: string
  readonly principalBinding: string
  readonly rootBinding: string
  readonly keyId: string
  readonly transactionId: string
  readonly source: string
  readonly destination: string
  readonly preMoveManifest: RuntimeOwnedTreeManifest
  readonly sourceParent: RuntimeRecordedTreeParent
  readonly destinationParent: RuntimeRecordedTreeParent
  readonly destinationWasAbsent: true
  readonly disposition: 'cleanup-owned' | 'restore-only'
  readonly payloadPlanIdentity: string
}

export interface AuthenticatedRuntimeOwnedTreeMoveIntent {
  readonly [authenticatedRuntimeOwnedTreeMoveIntent]: true
}

export interface RuntimeOwnedTreeMoveIntentIssuer {
  issue(record: RuntimeOwnedTreeMoveAuthenticatedInput): AuthenticatedRuntimeOwnedTreeMoveIntent
  retire(): void
}

export interface RuntimeOwnedTreeFileSink {
  write(chunk: Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }> & { readonly byteLength: number }>
}

export interface RuntimeOwnedTreeWriter {
  createRoot(): Promise<RuntimeDirectoryCreationReceipt>
  createDirectory(relativePath: string): Promise<RuntimeDirectoryCreationReceipt>
  createFile(pin: import('./runtime-payload-plan').RuntimePayloadFilePin): Promise<RuntimeOwnedTreeFileSink>
  renameFile(
    sourceRelativePath: string,
    destinationRelativePath: string,
    assertCurrentSync: () => void
  ): Promise<RuntimeOwnedTreeFileMutationResult>
  removeFile(relativePath: string, assertCurrentSync: () => void): Promise<{ readonly removed: true }>
  removeEmptyDirectory(relativePath: string, assertCurrentSync: () => void): Promise<{ readonly removed: true }>
  removeRoot(assertCurrentSync: () => void): Promise<{ readonly removed: true }>
  seal(): Promise<RuntimeOwnedTreeReceipt>
  dispose(): Promise<void>
}

export interface RuntimeOwnedTreeReceipt {
  readonly manifest: RuntimeOwnedTreeManifest
}

export type RuntimeOwnedTreeFileMutationResult =
  | { readonly status: 'moved'; readonly entry: Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }> }
  | { readonly status: 'moved-unconfirmed' }

interface IssuedTreeRecord {
  readonly binding: RuntimeOwnedTreeRecordBinding
  readonly manifest: RuntimeOwnedTreeManifest
  retired: boolean
}

const issuedTreeRecords = new WeakMap<object, IssuedTreeRecord>()
const issuedTreeMoveIntents = new WeakMap<
  object,
  {
    readonly binding: RuntimeOwnedTreeMoveIntentBinding
    readonly record: RuntimeOwnedTreeMoveAuthenticatedInput
    retired: boolean
  }
>()

export interface RuntimeOwnedTreeMoveIntentBinding {
  readonly profileBinding: string
  readonly principalBinding: string
  readonly rootBinding: string
  readonly keyId: string
  readonly plan: RuntimePayloadWritePlan
}

/** Create this issuer only inside the authenticated main registry verifier. */
export function createRuntimeOwnedTreeMoveIntentIssuer(
  binding: RuntimeOwnedTreeMoveIntentBinding
): RuntimeOwnedTreeMoveIntentIssuer {
  if (
    !binding.profileBinding ||
    !binding.principalBinding ||
    !/^[a-f0-9]{64}$/.test(binding.rootBinding) ||
    !/^[a-f0-9]{64}$/.test(binding.keyId)
  ) {
    throw new Error('RUNTIME_TREE_MOVE_ISSUER_BINDING_INVALID')
  }
  const fixed = Object.freeze({ ...binding })
  let retired = false
  const issued: { retired: boolean }[] = []
  return Object.freeze({
    issue(record: RuntimeOwnedTreeMoveAuthenticatedInput): AuthenticatedRuntimeOwnedTreeMoveIntent {
      if (retired) throw new Error('RUNTIME_TREE_MOVE_ISSUER_RETIRED')
      const copied = copyAndValidateMoveIntent(record, fixed)
      if (issued.length >= 8) throw new Error('RUNTIME_TREE_MOVE_INTENT_LIMIT')
      const token = Object.freeze({}) as AuthenticatedRuntimeOwnedTreeMoveIntent
      const state = { binding: fixed, record: copied, retired: false }
      issuedTreeMoveIntents.set(token, state)
      issued.push(state)
      return token
    },
    retire(): void {
      if (retired) return
      retired = true
      for (const state of issued) state.retired = true
    }
  })
}

export function readIssuedRuntimeOwnedTreeMoveIntent(
  intent: AuthenticatedRuntimeOwnedTreeMoveIntent
): RuntimeOwnedTreeMoveAuthenticatedInput {
  const state = issuedTreeMoveIntents.get(intent as object)
  if (!state || state.retired) throw new Error('RUNTIME_TREE_MOVE_INTENT_NOT_AUTHENTICATED')
  return state.record
}

function copyAndValidateMoveIntent(
  record: RuntimeOwnedTreeMoveAuthenticatedInput,
  binding: RuntimeOwnedTreeMoveIntentBinding
): RuntimeOwnedTreeMoveAuthenticatedInput {
  const expectedKeys = [
    'destination',
    'destinationParent',
    'destinationWasAbsent',
    'disposition',
    'keyId',
    'operation',
    'payloadPlanIdentity',
    'preMoveManifest',
    'principalBinding',
    'profileBinding',
    'purpose',
    'rootBinding',
    'schemaVersion',
    'source',
    'sourceParent',
    'transactionId'
  ].sort()
  if (
    !record ||
    Object.keys(record).sort().join('\0') !== expectedKeys.join('\0') ||
    record.schemaVersion !== 1 ||
    record.operation !== 'tree-move' ||
    record.purpose !== 'metis-speech-pack-owner-key/v1' ||
    record.profileBinding !== binding.profileBinding ||
    record.principalBinding !== binding.principalBinding ||
    record.rootBinding !== binding.rootBinding ||
    record.keyId !== binding.keyId ||
    record.payloadPlanIdentity !== runtimePayloadPlanIdentity(binding.plan) ||
    record.source !== runtimePayloadPlanRoot(binding.plan) ||
    !/^[a-f0-9-]{36}$/.test(record.transactionId) ||
    record.destinationWasAbsent !== true ||
    (record.disposition !== 'cleanup-owned' && record.disposition !== 'restore-only') ||
    !isSafeRelativePath(record.source) ||
    !isSafeRelativePath(record.destination) ||
    record.source === record.destination ||
    record.destination.startsWith(`${record.source}/`) ||
    record.source.startsWith(`${record.destination}/`)
  ) {
    throw new Error('RUNTIME_TREE_MOVE_INTENT_INVALID')
  }
  const sourceParentPath = relativeParent(record.source)
  const destinationParentPath = relativeParent(record.destination)
  const sourceParent = copyRecordedParent(record.sourceParent)
  const destinationParent = copyRecordedParent(record.destinationParent)
  const sourceName = record.source.split('/').at(-1)!
  const destinationName = record.destination.split('/').at(-1)!
  if (
    sourceParent.relativePath !== sourceParentPath ||
    destinationParent.relativePath !== destinationParentPath ||
    !sourceParent.children.includes(sourceName) ||
    destinationParent.children.includes(destinationName) ||
    (sourceParentPath === destinationParentPath &&
      (sourceParent.children.join('\0') !== destinationParent.children.join('\0') ||
        JSON.stringify(sourceParent.identity) !== JSON.stringify(destinationParent.identity)))
  ) {
    throw new Error('RUNTIME_TREE_MOVE_PARENT_RECORD_INVALID')
  }
  const manifest = copyAndValidateManifest(record.preMoveManifest)
  const claims = runtimePayloadPlanFileClaims(binding.plan)
  const budget = runtimePayloadPlanBudget(binding.plan)
  const expectedFiles = new Map(claims.map((claim) => [claim.relativePath, claim]))
  const actualFiles = new Map(
    manifest.entries
      .filter((entry): entry is Extract<RuntimeOwnedTreeEntry, { readonly kind: 'file' }> => entry.kind === 'file')
      .map((entry) => [entry.path, entry])
  )
  const expectedDirectories = new Set<string>()
  for (const claim of claims) {
    const parts = claim.relativePath.split('/')
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'))
  }
  const actualDirectories = new Set(
    manifest.entries
      .filter(
        (entry): entry is Extract<RuntimeOwnedTreeEntry, { readonly kind: 'directory' }> => entry.kind === 'directory'
      )
      .map((entry) => entry.path)
  )
  const manifestPathBytes = manifest.entries.reduce(
    (total, entry) =>
      total +
      Buffer.byteLength(entry.path) +
      (entry.kind === 'directory' ? entry.children.reduce((sum, name) => sum + Buffer.byteLength(name), 0) : 0),
    0
  )
  if (
    expectedFiles.size !== actualFiles.size ||
    [...expectedFiles].some(([path, claim]) => {
      const actual = actualFiles.get(path)
      return !actual || actual.sha256 !== claim.sha256 || actual.identity.size !== String(claim.byteLength)
    }) ||
    expectedDirectories.size !== actualDirectories.size ||
    [...expectedDirectories].some((path) => !actualDirectories.has(path)) ||
    manifestPathBytes > budget.maximumPathBytes ||
    !sameIdentityValues(manifest.rootParent, sourceParent.identity) ||
    budget.fileCount !== expectedFiles.size ||
    claims.reduce((total, claim) => total + claim.byteLength, 0) > budget.maximumBytes
  ) {
    throw new Error('RUNTIME_TREE_MOVE_PAYLOAD_PLAN_MISMATCH')
  }
  return Object.freeze({
    ...record,
    preMoveManifest: manifest,
    sourceParent,
    destinationParent
  })
}

function copyRecordedParent(parent: RuntimeRecordedTreeParent): RuntimeRecordedTreeParent {
  if (
    !parent ||
    typeof parent.relativePath !== 'string' ||
    (parent.relativePath !== '' && !isSafeRelativePath(parent.relativePath)) ||
    !Array.isArray(parent.children) ||
    parent.children.length > 128
  ) {
    throw new Error('RUNTIME_TREE_MOVE_PARENT_RECORD_INVALID')
  }
  const children = [...parent.children]
  if (
    children.some((name) => !isSingleName(name)) ||
    new Set(children).size !== children.length ||
    children.some((name) => Buffer.byteLength(name) > 255)
  ) {
    throw new Error('RUNTIME_TREE_MOVE_PARENT_RECORD_INVALID')
  }
  return Object.freeze({
    relativePath: parent.relativePath,
    identity: copyIdentity(parent.identity),
    children: Object.freeze(children.sort())
  })
}

function relativeParent(path: string): string {
  const parent = dirname(path)
  return parent === '.' ? '' : parent.split(sep).join('/')
}

function sameIdentityValues(left: RuntimeOwnedTreeIdentity, right: RuntimeOwnedTreeIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.rdev === right.rdev &&
    left.size === right.size &&
    left.blocks === right.blocks &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.birthtimeNs === right.birthtimeNs
  )
}

/** Inject this issuer only into the main-owned authenticated receipt-store verifier. */
export function createRuntimeOwnedTreeRecordIssuer(
  binding: RuntimeOwnedTreeRecordBinding
): RuntimeOwnedTreeRecordIssuer {
  if (
    binding.purpose !== 'metis-speech-pack-owner-key/v1' ||
    binding.schemaVersion !== 2 ||
    !binding.profileBinding ||
    !binding.principalBinding ||
    !binding.rootBinding ||
    !isAbsolute(binding.rootPath) ||
    resolve(binding.rootPath) !== binding.rootPath
  ) {
    throw new Error('RUNTIME_TREE_RECORD_BINDING_INVALID')
  }
  const fixedBinding = Object.freeze({ ...binding })
  let retired = false
  const issued: IssuedTreeRecord[] = []
  return Object.freeze({
    issue(record: RuntimeOwnedTreeAuthenticatedInput): AuthenticatedRuntimeOwnedTreeRecord {
      if (retired) throw new Error('RUNTIME_TREE_RECORD_ISSUER_RETIRED')
      if (issued.length >= 128) throw new Error('RUNTIME_TREE_RECORD_LIMIT')
      assertRecordBinding(fixedBinding, record)
      const manifest = copyAndValidateManifest(record.manifest)
      const token = Object.freeze({}) as AuthenticatedRuntimeOwnedTreeRecord
      const tokenState = { binding: fixedBinding, manifest, retired: false }
      issuedTreeRecords.set(token, tokenState)
      issued.push(tokenState)
      return token
    },
    retire(): void {
      if (retired) return
      retired = true
      for (const record of issued) record.retired = true
    }
  })
}

export function readIssuedRuntimeOwnedTreeRecord(record: AuthenticatedRuntimeOwnedTreeRecord): {
  readonly binding: RuntimeOwnedTreeRecordBinding
  readonly manifest: RuntimeOwnedTreeManifest
} {
  const issued = issuedTreeRecords.get(record as object)
  if (!issued || issued.retired) throw new Error('RUNTIME_TREE_RECORD_NOT_AUTHENTICATED')
  return { binding: issued.binding, manifest: issued.manifest }
}

export function identityRecord(version: BigIntStats): RuntimeOwnedTreeIdentity {
  return Object.freeze({
    dev: version.dev.toString(),
    ino: version.ino.toString(),
    mode: version.mode.toString(),
    nlink: version.nlink.toString(),
    uid: version.uid.toString(),
    gid: version.gid.toString(),
    rdev: version.rdev.toString(),
    size: version.size.toString(),
    blocks: version.blocks.toString(),
    mtimeNs: version.mtimeNs.toString(),
    ctimeNs: version.ctimeNs.toString(),
    birthtimeNs: version.birthtimeNs.toString()
  })
}

export function sameIdentityRecord(expected: RuntimeOwnedTreeIdentity, actual: BigIntStats): boolean {
  const value = identityRecord(actual)
  return (
    expected.dev === value.dev &&
    expected.ino === value.ino &&
    expected.mode === value.mode &&
    expected.nlink === value.nlink &&
    expected.uid === value.uid &&
    expected.gid === value.gid &&
    expected.rdev === value.rdev &&
    expected.size === value.size &&
    expected.blocks === value.blocks &&
    expected.mtimeNs === value.mtimeNs &&
    expected.ctimeNs === value.ctimeNs &&
    expected.birthtimeNs === value.birthtimeNs
  )
}

export function ensureContained(rootPath: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) throw new Error('RUNTIME_TREE_PATH_INVALID')
  const path = resolve(rootPath, ...relativePath.split('/'))
  const rel = relative(rootPath, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || path !== join(rootPath, ...relativePath.split('/'))) {
    throw new Error('RUNTIME_TREE_PATH_INVALID')
  }
  return path
}

export function makeRuntimeOwnedTreeManifest(
  rootPath: string,
  snapshot: RuntimePhysicalSnapshotInput,
  fileDigests: ReadonlyMap<string, string>
): RuntimeOwnedTreeManifest {
  const root = snapshot.nodes.find((node) => node.path === rootPath)?.version
  const rootParent = snapshot.nodes.find((node) => node.path === dirname(rootPath))?.version
  if (!root?.isDirectory() || !rootParent?.isDirectory()) throw new Error('RUNTIME_TREE_ROOT_UNCONFIRMED')
  const rootLength = rootPath.length + 1
  const entries: RuntimeOwnedTreeEntry[] = []
  for (const directory of snapshot.directories) {
    if (directory.path === rootPath || !directory.path.startsWith(`${rootPath}${sep}`)) continue
    entries.push(
      Object.freeze({
        path: directory.path.slice(rootLength).split(sep).join('/'),
        kind: 'directory',
        identity: identityRecord(directory.version),
        children: Object.freeze([...directory.children].sort())
      })
    )
  }
  for (const node of snapshot.nodes) {
    if (!node.path.startsWith(`${rootPath}${sep}`) || node.version.isDirectory()) continue
    const sha256 = fileDigests.get(node.path)
    if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('RUNTIME_TREE_DIGEST_MISSING')
    entries.push(
      Object.freeze({
        path: node.path.slice(rootLength).split(sep).join('/'),
        kind: 'file',
        identity: identityRecord(node.version),
        sha256
      })
    )
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  if (entries.length > MAX_TREE_NODES) throw new Error('RUNTIME_TREE_LIMIT')
  const pathBytes = entries.reduce(
    (total, entry) =>
      total +
      Buffer.byteLength(entry.path) +
      (entry.kind === 'directory' ? entry.children.reduce((size, name) => size + Buffer.byteLength(name), 0) : 0),
    0
  )
  if (pathBytes > MAX_TREE_PATH_BYTES) throw new Error('RUNTIME_TREE_LIMIT')
  return Object.freeze({
    schemaVersion: 2,
    root: identityRecord(root),
    rootParent: identityRecord(rootParent),
    entries: Object.freeze(entries)
  })
}

function copyAndValidateManifest(manifest: RuntimeOwnedTreeManifest): RuntimeOwnedTreeManifest {
  if (
    !manifest ||
    manifest.schemaVersion !== 2 ||
    !manifest.root ||
    !manifest.rootParent ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error('RUNTIME_TREE_RECORD_INVALID')
  }
  if (manifest.entries.length > MAX_TREE_NODES) throw new Error('RUNTIME_TREE_LIMIT')
  let pathBytes = 0
  const seen = new Set<string>()
  const entries: RuntimeOwnedTreeEntry[] = []
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== 'string' || !isSafeRelativePath(entry.path)) {
      throw new Error('RUNTIME_TREE_RECORD_INVALID')
    }
    pathBytes += Buffer.byteLength(entry.path)
    if (pathBytes > MAX_TREE_PATH_BYTES || seen.has(entry.path)) throw new Error('RUNTIME_TREE_LIMIT')
    seen.add(entry.path)
    if (entry.kind === 'directory') {
      if (!Array.isArray(entry.children) || entry.children.length > MAX_TREE_NODES) {
        throw new Error('RUNTIME_TREE_RECORD_INVALID')
      }
      const children = [...entry.children]
      if (children.some((name) => !isSingleName(name)) || new Set(children).size !== children.length) {
        throw new Error('RUNTIME_TREE_RECORD_INVALID')
      }
      pathBytes += children.reduce((total, name) => total + Buffer.byteLength(name), 0)
      if (pathBytes > MAX_TREE_PATH_BYTES) throw new Error('RUNTIME_TREE_LIMIT')
      entries.push(
        Object.freeze({
          path: entry.path,
          kind: 'directory',
          identity: copyIdentity(entry.identity),
          children: Object.freeze(children)
        })
      )
    } else if (entry.kind === 'file') {
      if (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
        throw new Error('RUNTIME_TREE_RECORD_INVALID')
      }
      entries.push(
        Object.freeze({ path: entry.path, kind: 'file', identity: copyIdentity(entry.identity), sha256: entry.sha256 })
      )
    } else {
      throw new Error('RUNTIME_TREE_RECORD_INVALID')
    }
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  for (const entry of entries) {
    const parent = dirname(entry.path) === '.' ? '' : dirname(entry.path).split(sep).join('/')
    if (parent && byPath.get(parent)?.kind !== 'directory') throw new Error('RUNTIME_TREE_RECORD_INVALID')
    if (parent) {
      const parentEntry = byPath.get(parent)
      if (parentEntry?.kind !== 'directory' || !parentEntry.children.includes(entry.path.split(sep).at(-1) ?? '')) {
        throw new Error('RUNTIME_TREE_RECORD_INVALID')
      }
    }
  }
  return Object.freeze({
    schemaVersion: 2,
    root: copyIdentity(manifest.root),
    rootParent: copyIdentity(manifest.rootParent),
    entries: Object.freeze(entries)
  })
}

function copyIdentity(identity: RuntimeOwnedTreeIdentity): RuntimeOwnedTreeIdentity {
  const fields = [
    'dev',
    'ino',
    'mode',
    'nlink',
    'uid',
    'gid',
    'rdev',
    'size',
    'blocks',
    'mtimeNs',
    'ctimeNs',
    'birthtimeNs'
  ] as const
  if (
    !identity ||
    fields.some((field) => typeof identity[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(identity[field]))
  ) {
    throw new Error('RUNTIME_TREE_RECORD_INVALID')
  }
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field, identity[field]])) as unknown as RuntimeOwnedTreeIdentity
  )
}

function assertRecordBinding(expected: RuntimeOwnedTreeRecordBinding, actual: RuntimeOwnedTreeRecordBinding): void {
  if (
    actual.purpose !== expected.purpose ||
    actual.schemaVersion !== expected.schemaVersion ||
    actual.profileBinding !== expected.profileBinding ||
    actual.principalBinding !== expected.principalBinding ||
    actual.rootBinding !== expected.rootBinding ||
    actual.rootPath !== expected.rootPath
  ) {
    throw new Error('RUNTIME_TREE_RECORD_BINDING_INVALID')
  }
}

function isSingleName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0')
}

function isSafeRelativePath(path: string): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((part) => isSingleName(part))
  )
}
