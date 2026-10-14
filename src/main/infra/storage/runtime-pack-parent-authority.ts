import type { RuntimePackNamespace } from './runtime-pack-namespace'
import {
  runtimePayloadPlanIdentity,
  runtimePayloadPlanParentGraph,
  type RuntimePayloadWritePlan
} from './runtime-payload-plan'
import type { RuntimeProfileBinding, RuntimeStableOwner } from './runtime-purpose-root'

const MAX_PARENT_RECORD_DIRECTORIES = 2
const MAX_PARENT_RECORD_CHILDREN = 128

declare const authorityBrand: unique symbol
export type RuntimePackParentAuthority = { readonly [authorityBrand]: true }

export interface RuntimePackParentDirectoryRecord {
  readonly relativePath: string
  readonly identity: RuntimeStableOwner
  readonly version: RuntimePackFullDirectoryVersion
  readonly children: readonly string[]
}

export interface RuntimePackFullDirectoryVersion extends RuntimeStableOwner {
  readonly size: string
  readonly blocks: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}

export interface RuntimePackParentRecord {
  readonly schemaVersion: 1
  readonly purpose: 'metis-speech-pack-tree-parent/v1'
  readonly rootBinding: string
  readonly profileBinding: string
  readonly principalBinding: string
  readonly planIdentity: string
  readonly lane: 'legacy' | 'staging' | 'active' | 'work'
  readonly componentId: string
  readonly componentVersion: string
  readonly directories: readonly RuntimePackParentDirectoryRecord[]
}

export interface RuntimePackParentAuthorityIssuer {
  issue(record: RuntimePackParentRecord): RuntimePackParentAuthority
  retire(): void
}

export interface RuntimePackNamespaceAuthorityBinding {
  readonly bindingId: string
  readonly profileBinding: string
  readonly principalBinding: string
}

interface IssuedAuthority {
  readonly namespace: RuntimePackNamespace
  readonly plan: RuntimePayloadWritePlan
  readonly record: RuntimePackParentRecord
  readonly assertCurrentSync: () => void
  retired: boolean
}

const authorities = new WeakMap<object, IssuedAuthority>()

/** Construct only inside the authenticated main registry verifier for a current namespace. */
export function createRuntimePackParentAuthorityIssuer(input: {
  readonly namespace: RuntimePackNamespace
  readonly binding: RuntimePackNamespaceAuthorityBinding
  readonly plan: RuntimePayloadWritePlan
  readonly assertCurrentSync: () => void
}): RuntimePackParentAuthorityIssuer {
  input.assertCurrentSync()
  const graph = runtimePayloadPlanParentGraph(input.plan)
  let retired = false
  const issued: IssuedAuthority[] = []
  return Object.freeze({
    issue(record: RuntimePackParentRecord): RuntimePackParentAuthority {
      input.assertCurrentSync()
      if (retired || issued.length >= 16) throw new Error('RUNTIME_PACK_PARENT_ISSUER_RETIRED')
      const copied = validateRecord(record, {
        rootBinding: input.binding.bindingId,
        profileBinding: input.binding.profileBinding,
        principalBinding: input.binding.principalBinding,
        planIdentity: runtimePayloadPlanIdentity(input.plan),
        lane: graph.lane,
        componentId: graph.componentId,
        componentVersion: graph.componentVersion,
        parentChain: graph.parentChain
      })
      input.assertCurrentSync()
      const token = Object.freeze({}) as RuntimePackParentAuthority
      const state: IssuedAuthority = {
        namespace: input.namespace,
        plan: input.plan,
        record: copied,
        assertCurrentSync: input.assertCurrentSync,
        retired: false
      }
      authorities.set(token, state)
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

export function readIssuedRuntimePackParentAuthority(
  authority: RuntimePackParentAuthority,
  namespace: RuntimePackNamespace,
  plan: RuntimePayloadWritePlan
): RuntimePackParentRecord {
  const state = authorities.get(authority as object)
  if (!state || state.retired || state.namespace !== namespace || state.plan !== plan) {
    throw new Error('RUNTIME_PACK_PARENT_AUTHORITY_INVALID')
  }
  state.assertCurrentSync()
  return state.record
}

export function assertRuntimePackParentAuthorityBinding(
  record: RuntimePackParentRecord,
  expected: Pick<
    RuntimePackParentRecord,
    'rootBinding' | 'profileBinding' | 'principalBinding' | 'planIdentity' | 'lane' | 'componentId' | 'componentVersion'
  >
): void {
  if (
    record.rootBinding !== expected.rootBinding ||
    record.profileBinding !== expected.profileBinding ||
    record.principalBinding !== expected.principalBinding ||
    record.planIdentity !== expected.planIdentity ||
    record.lane !== expected.lane ||
    record.componentId !== expected.componentId ||
    record.componentVersion !== expected.componentVersion
  ) {
    throw new Error('RUNTIME_TREE_PARENT_AUTHORITY_BINDING_INVALID')
  }
}

export function assertRuntimePackParentAuthorityForPlan(
  record: RuntimePackParentRecord,
  rootBinding: string,
  profile: RuntimeProfileBinding,
  plan: RuntimePayloadWritePlan
): void {
  const graph = runtimePayloadPlanParentGraph(plan)
  assertRuntimePackParentAuthorityBinding(record, {
    rootBinding,
    profileBinding: profile.profileBinding,
    principalBinding: profile.principalBinding,
    planIdentity: runtimePayloadPlanIdentity(plan),
    lane: graph.lane,
    componentId: graph.componentId,
    componentVersion: graph.componentVersion
  })
}

export function copyRuntimePackParentRecord(record: RuntimePackParentRecord): RuntimePackParentRecord {
  return Object.freeze({
    ...record,
    directories: Object.freeze(
      record.directories.map((directory) =>
        Object.freeze({
          relativePath: directory.relativePath,
          identity: Object.freeze({ ...directory.identity }),
          version: Object.freeze({ ...directory.version }),
          children: Object.freeze([...directory.children])
        })
      )
    )
  })
}

function validateRecord(
  record: RuntimePackParentRecord,
  expected: {
    readonly rootBinding: string
    readonly profileBinding: string
    readonly principalBinding: string
    readonly planIdentity: string
    readonly lane: RuntimePackParentRecord['lane']
    readonly componentId: string
    readonly componentVersion: string
    readonly parentChain: readonly string[]
  }
): RuntimePackParentRecord {
  const exactKeys = [
    'componentId',
    'componentVersion',
    'directories',
    'lane',
    'planIdentity',
    'principalBinding',
    'profileBinding',
    'purpose',
    'rootBinding',
    'schemaVersion'
  ].sort()
  if (
    !record ||
    Object.keys(record).sort().join('\0') !== exactKeys.join('\0') ||
    record.schemaVersion !== 1 ||
    record.purpose !== 'metis-speech-pack-tree-parent/v1' ||
    record.rootBinding !== expected.rootBinding ||
    record.profileBinding !== expected.profileBinding ||
    record.principalBinding !== expected.principalBinding ||
    record.planIdentity !== expected.planIdentity ||
    record.lane !== expected.lane ||
    record.componentId !== expected.componentId ||
    record.componentVersion !== expected.componentVersion ||
    !Array.isArray(record.directories) ||
    record.directories.length > expected.parentChain.length ||
    record.directories.length > MAX_PARENT_RECORD_DIRECTORIES
  ) {
    throw new Error('RUNTIME_PACK_PARENT_RECORD_INVALID')
  }
  const directories = record.directories.map((directory, index) => {
    const fields = ['children', 'identity', 'relativePath', 'version'].sort()
    if (
      !directory ||
      Object.keys(directory).sort().join('\0') !== fields.join('\0') ||
      directory.relativePath !== expected.parentChain[index] ||
      !validStableOwner(directory.identity) ||
      !validFullVersion(directory.version) ||
      !sameOwner(directory.identity, directory.version) ||
      !Array.isArray(directory.children) ||
      directory.children.length > MAX_PARENT_RECORD_CHILDREN
    ) {
      throw new Error('RUNTIME_PACK_PARENT_RECORD_INVALID')
    }
    const children = [...directory.children]
    if (children.some((name) => !safeName(name)) || new Set(children).size !== children.length) {
      throw new Error('RUNTIME_PACK_PARENT_RECORD_INVALID')
    }
    if (index + 1 < record.directories.length) {
      const nextName = expected.parentChain[index + 1].slice(directory.relativePath.length + 1)
      if (!children.includes(nextName)) throw new Error('RUNTIME_PACK_PARENT_RECORD_INVALID')
    }
    return Object.freeze({
      relativePath: directory.relativePath,
      identity: Object.freeze({ ...directory.identity }),
      version: Object.freeze({ ...directory.version }),
      children: Object.freeze(children.sort())
    })
  })
  return Object.freeze({
    schemaVersion: 1,
    purpose: 'metis-speech-pack-tree-parent/v1',
    rootBinding: expected.rootBinding,
    profileBinding: expected.profileBinding,
    principalBinding: expected.principalBinding,
    planIdentity: expected.planIdentity,
    lane: expected.lane,
    componentId: expected.componentId,
    componentVersion: expected.componentVersion,
    directories: Object.freeze(directories)
  })
}

function validStableOwner(owner: RuntimeStableOwner): boolean {
  const fields = ['birthtimeNs', 'dev', 'gid', 'ino', 'mode', 'rdev', 'uid']
  return (
    owner !== null &&
    typeof owner === 'object' &&
    Object.keys(owner).sort().join('\0') === [...fields].sort().join('\0') &&
    fields.every((field) => typeof owner[field as keyof RuntimeStableOwner] === 'string')
  )
}

function validFullVersion(version: RuntimePackFullDirectoryVersion): boolean {
  const fields = ['birthtimeNs', 'blocks', 'ctimeNs', 'dev', 'gid', 'ino', 'mode', 'mtimeNs', 'rdev', 'size', 'uid']
  return (
    version !== null &&
    typeof version === 'object' &&
    Object.keys(version).sort().join('\0') === [...fields].sort().join('\0') &&
    fields.every((field) => typeof version[field as keyof RuntimePackFullDirectoryVersion] === 'string')
  )
}

function sameOwner(owner: RuntimeStableOwner, version: RuntimePackFullDirectoryVersion): boolean {
  return (
    owner.dev === version.dev &&
    owner.ino === version.ino &&
    owner.birthtimeNs === version.birthtimeNs &&
    owner.mode === version.mode &&
    owner.uid === version.uid &&
    owner.gid === version.gid &&
    owner.rdev === version.rdev
  )
}

function safeName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    Buffer.byteLength(name) <= 255 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !name.includes(':') &&
    name !== '.' &&
    name !== '..'
  )
}
