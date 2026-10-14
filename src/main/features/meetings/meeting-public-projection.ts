import { Buffer, constants as bufferConstants } from 'node:buffer'
import { isAbsolute, join } from 'node:path'
import type { ContentVersion, FileClass, StorageGateway } from '../../infra/storage/gateway'
import { publicMeetingTextAsync } from './meeting-speech'
import { hasMeetingFlag, parse as parseMeetingDocument } from './meeting-document'
import { decodeSavedMeetingAsync } from '../../transcripts'

export type MeetingProjectionSourceKind = 'meeting' | 'ordinary' | 'published-wiki'
export interface MeetingProjectionCandidate {
  readonly logicalPath: string
  readonly sourceKind: MeetingProjectionSourceKind
  readonly expectedVersion: ContentVersion
}
export interface MeetingProjectionSourceHandle {
  readonly logicalPath: string
  readonly sourceKind: MeetingProjectionSourceKind
  readonly sourceVersion: ContentVersion
}
export interface MeetingProjectionLimits {
  /** Explicit finite main-owned budgets; this reader has no production defaults. */
  readonly maxCandidates: number
  readonly maxSourceBytes: number
  readonly maxPublicBytes: number
  readonly maxChunkBytes: number
}
export interface MeetingProjectionAuthority {
  readonly root: string
  readonly rootIdentity: string
  readonly limits: MeetingProjectionLimits
}
export type MeetingProjectionRefusal = 'STALE_OWNER' | 'SOURCE_CHANGED' | 'UNAVAILABLE' | 'LIMIT' | 'AMBIGUOUS_FRAME'
export type MeetingProjectionAdmission =
  | { readonly ok: true; readonly handles: readonly MeetingProjectionSourceHandle[] }
  | { readonly ok: false; readonly reason: MeetingProjectionRefusal }
export type MeetingProjectionResult =
  | {
      readonly ok: true
      readonly metadata: {
        readonly logicalPath: string
        readonly sourceKind: MeetingProjectionSourceKind
        readonly sourceVersion: ContentVersion
        readonly confidentialDisposition: 'clear' | 'confidential'
        readonly sourceBytes: number
        readonly publicBytes: number
      }
    }
  | { readonly ok: false; readonly reason: MeetingProjectionRefusal }

export interface MeetingPublicProjectionDependencies {
  /** Synchronous main-owned lookup. It must return no authority when the opaque owner has been retired. */
  readAuthority(ownerToken: object): MeetingProjectionAuthority | undefined
  gatewayForRoot(root: string): StorageGateway
}

interface BoundSource {
  readonly ownerToken: object
  readonly root: string
  readonly rootIdentity: string
  readonly candidate: MeetingProjectionCandidate
}

const REFUSALS = new Set<MeetingProjectionRefusal>([
  'STALE_OWNER',
  'SOURCE_CHANGED',
  'UNAVAILABLE',
  'LIMIT',
  'AMBIGUOUS_FRAME'
])

function validVersion(value: ContentVersion): boolean {
  return (
    Number.isFinite(value.mtimeMs) &&
    Number.isFinite(value.ctimeMs) &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0
  )
}

function validPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512 || path.includes('\0') || path.includes('\\'))
    return false
  if (path.startsWith('/') || !path.endsWith('.md')) return false
  const parts = path.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function validLimits(value: MeetingProjectionLimits): boolean {
  return (
    Number.isSafeInteger(value.maxCandidates) &&
    value.maxCandidates > 0 &&
    Number.isSafeInteger(value.maxSourceBytes) &&
    value.maxSourceBytes > 0 &&
    value.maxSourceBytes <= bufferConstants.MAX_LENGTH &&
    Number.isSafeInteger(value.maxPublicBytes) &&
    value.maxPublicBytes > 0 &&
    value.maxPublicBytes <= bufferConstants.MAX_LENGTH &&
    Number.isSafeInteger(value.maxChunkBytes) &&
    value.maxChunkBytes > 0 &&
    value.maxChunkBytes <= value.maxSourceBytes &&
    value.maxChunkBytes <= value.maxPublicBytes
  )
}

function sameVersion(left: ContentVersion, right: ContentVersion): boolean {
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.size === right.size
}

function hasExactDataFields(value: object, expected: string): boolean {
  if (Object.keys(value).sort().join(',') !== expected) return false
  return Object.keys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return Boolean(descriptor && 'value' in descriptor && descriptor.get === undefined && descriptor.set === undefined)
  })
}

function sourceCandidate(value: MeetingProjectionCandidate): MeetingProjectionCandidate | undefined {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return undefined
  if (!hasExactDataFields(value, 'expectedVersion,logicalPath,sourceKind')) return undefined
  if (!validPath(value.logicalPath) || !['meeting', 'ordinary', 'published-wiki'].includes(value.sourceKind))
    return undefined
  if (!value.expectedVersion || Object.getPrototypeOf(value.expectedVersion) !== Object.prototype) return undefined
  if (!hasExactDataFields(value.expectedVersion, 'ctimeMs,mtimeMs,size') || !validVersion(value.expectedVersion))
    return undefined
  return Object.freeze({
    logicalPath: value.logicalPath,
    sourceKind: value.sourceKind,
    expectedVersion: Object.freeze({ ...value.expectedVersion })
  })
}

function authoritySnapshot(value: MeetingProjectionAuthority | undefined): MeetingProjectionAuthority | undefined {
  if (
    !value ||
    typeof value.root !== 'string' ||
    !isAbsolute(value.root) ||
    value.root.includes('\0') ||
    typeof value.rootIdentity !== 'string' ||
    value.rootIdentity.length === 0
  )
    return undefined
  if (!validLimits(value.limits)) return undefined
  return Object.freeze({
    root: value.root,
    rootIdentity: value.rootIdentity,
    limits: Object.freeze({ ...value.limits })
  })
}

function sameAuthority(left: MeetingProjectionAuthority | undefined, right: MeetingProjectionAuthority): boolean {
  const current = authoritySnapshot(left)
  return Boolean(
    current &&
      current.root === right.root &&
      current.rootIdentity === right.rootIdentity &&
      current.limits.maxCandidates === right.limits.maxCandidates &&
      current.limits.maxSourceBytes === right.limits.maxSourceBytes &&
      current.limits.maxPublicBytes === right.limits.maxPublicBytes &&
      current.limits.maxChunkBytes === right.limits.maxChunkBytes
  )
}

function streamRefusal(
  result: Exclude<Awaited<ReturnType<StorageGateway['stream']>>, { status: 'ok' }>
): MeetingProjectionRefusal {
  if ('code' in result && ['STALE_OWNER', 'SOURCE_CHANGED', 'SIZE_LIMIT', 'INVALID_SIZE_LIMIT'].includes(result.code))
    return result.code === 'STALE_OWNER' ? 'STALE_OWNER' : result.code === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'LIMIT'
  return 'UNAVAILABLE'
}

function fileVersion(fileClass: FileClass): ContentVersion | undefined {
  return fileClass.status === 'ok' ? fileClass.version : undefined
}

export interface MeetingPublicProjectionReader {
  admit(ownerToken: object, candidates: readonly MeetingProjectionCandidate[]): Promise<MeetingProjectionAdmission>
  project(
    ownerToken: object,
    handle: MeetingProjectionSourceHandle,
    sink: (chunk: Uint8Array) => void | Promise<void>,
    signal?: AbortSignal
  ): Promise<MeetingProjectionResult>
}

export function createMeetingPublicProjectionReader(
  dependencies: MeetingPublicProjectionDependencies
): MeetingPublicProjectionReader {
  const handles = new WeakMap<object, BoundSource>()

  function current(ownerToken: object, expected: MeetingProjectionAuthority): boolean {
    try {
      return sameAuthority(dependencies.readAuthority(ownerToken), expected)
    } catch {
      return false
    }
  }

  return {
    async admit(ownerToken, candidates) {
      if (!ownerToken || typeof ownerToken !== 'object' || !Array.isArray(candidates))
        return { ok: false, reason: 'UNAVAILABLE' }
      let authority: MeetingProjectionAuthority | undefined
      try {
        authority = authoritySnapshot(dependencies.readAuthority(ownerToken))
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' }
      }
      if (!authority) return { ok: false, reason: 'UNAVAILABLE' }
      if (candidates.length === 0 || candidates.length > authority.limits.maxCandidates)
        return { ok: false, reason: 'LIMIT' }
      let admitted: Array<MeetingProjectionCandidate | undefined>
      try {
        admitted = candidates.map(sourceCandidate)
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' }
      }
      if (admitted.some((candidate) => !candidate)) return { ok: false, reason: 'UNAVAILABLE' }
      const paths = (admitted as MeetingProjectionCandidate[]).map((candidate) => candidate.logicalPath)
      if (new Set(paths.map((path) => path.toLocaleLowerCase('en-US'))).size !== paths.length)
        return { ok: false, reason: 'UNAVAILABLE' }
      if (!current(ownerToken, authority)) return { ok: false, reason: 'STALE_OWNER' }
      let classes: Map<string, FileClass>
      try {
        classes = await dependencies.gatewayForRoot(authority.root).classify(paths)
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' }
      }
      if (!current(ownerToken, authority)) return { ok: false, reason: 'STALE_OWNER' }
      const output: MeetingProjectionSourceHandle[] = []
      for (const candidate of admitted as MeetingProjectionCandidate[]) {
        const fileClass = classes.get(candidate.logicalPath)
        if (!fileClass || fileClass.status !== 'ok' || fileClass.isSymlink || !fileClass.isRegular)
          return { ok: false, reason: 'UNAVAILABLE' }
        const version = fileVersion(fileClass)
        if (!version || !sameVersion(version, candidate.expectedVersion)) return { ok: false, reason: 'SOURCE_CHANGED' }
        const handle = Object.freeze({
          logicalPath: candidate.logicalPath,
          sourceKind: candidate.sourceKind,
          sourceVersion: Object.freeze({ ...version })
        })
        handles.set(handle, {
          ownerToken,
          root: authority.root,
          rootIdentity: authority.rootIdentity,
          candidate
        })
        output.push(handle)
      }
      return { ok: true, handles: Object.freeze(output) }
    },

    async project(ownerToken, handle, sink, signal) {
      if (
        !ownerToken ||
        typeof ownerToken !== 'object' ||
        !handle ||
        typeof handle !== 'object' ||
        typeof sink !== 'function'
      )
        return { ok: false, reason: 'UNAVAILABLE' }
      const bound = handles.get(handle)
      if (!bound || bound.ownerToken !== ownerToken) return { ok: false, reason: 'UNAVAILABLE' }
      let authority: MeetingProjectionAuthority | undefined
      try {
        authority = authoritySnapshot(dependencies.readAuthority(ownerToken))
      } catch {
        return { ok: false, reason: 'STALE_OWNER' }
      }
      if (!authority || !current(ownerToken, authority)) return { ok: false, reason: 'STALE_OWNER' }
      if (authority.root !== bound.root || authority.rootIdentity !== bound.rootIdentity)
        return { ok: false, reason: 'STALE_OWNER' }
      const candidate = bound.candidate
      const sourceChunks: Uint8Array[] = []
      const clearSourceChunks = (): void => {
        for (const chunk of sourceChunks) chunk.fill(0)
        sourceChunks.length = 0
      }
      let sourceBytes = 0
      let gateway: StorageGateway
      try {
        gateway = dependencies.gatewayForRoot(bound.root)
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' }
      }
      let streamed: Awaited<ReturnType<StorageGateway['stream']>>
      try {
        streamed = await gateway.stream(
          candidate.logicalPath,
          async (chunk, readSignal) => {
            if (signal?.aborted || readSignal.aborted) throw codedFailure('UNAVAILABLE')
            if (!current(ownerToken, authority!)) throw codedFailure('STALE_OWNER')
            if (sourceBytes > authority!.limits.maxSourceBytes - chunk.byteLength) throw codedFailure('LIMIT')
            sourceChunks.push(chunk)
            sourceBytes += chunk.byteLength
          },
          {
            maxBytes: authority.limits.maxSourceBytes,
            maxChunkBytes: authority.limits.maxChunkBytes,
            signal
          }
        )
      } catch {
        clearSourceChunks()
        return { ok: false, reason: 'UNAVAILABLE' }
      }
      if (!current(ownerToken, authority)) {
        clearSourceChunks()
        return { ok: false, reason: 'STALE_OWNER' }
      }
      if (streamed.status !== 'ok') {
        clearSourceChunks()
        return { ok: false, reason: streamRefusal(streamed) }
      }
      if (!sameVersion(streamed.version, candidate.expectedVersion) || streamed.bytesRead !== sourceBytes) {
        clearSourceChunks()
        return { ok: false, reason: 'SOURCE_CHANGED' }
      }
      if (signal?.aborted) {
        clearSourceChunks()
        return { ok: false, reason: 'UNAVAILABLE' }
      }
      let source: Buffer
      try {
        source = Buffer.concat(sourceChunks, sourceBytes)
      } catch {
        clearSourceChunks()
        return { ok: false, reason: 'LIMIT' }
      }
      clearSourceChunks()
      let decoded: string
      try {
        const text =
          candidate.sourceKind === 'meeting'
            ? await decodeSavedMeetingAsync(source, false, join(bound.root, candidate.logicalPath))
            : { ok: true as const, text: new TextDecoder('utf-8', { fatal: true }).decode(source) }
        if (!text.ok) return { ok: false, reason: 'UNAVAILABLE' }
        decoded = text.text
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' }
      } finally {
        source.fill(0)
      }
      if (signal?.aborted) return { ok: false, reason: 'UNAVAILABLE' }
      if (!current(ownerToken, authority)) return { ok: false, reason: 'STALE_OWNER' }
      if (Buffer.byteLength(decoded, 'utf8') > authority.limits.maxSourceBytes) return { ok: false, reason: 'LIMIT' }
      let publicText: string
      try {
        publicText = await publicMeetingTextAsync(decoded)
      } catch {
        return { ok: false, reason: 'UNAVAILABLE' }
      }
      if (signal?.aborted) return { ok: false, reason: 'UNAVAILABLE' }
      if (!current(ownerToken, authority)) return { ok: false, reason: 'STALE_OWNER' }
      const publicBytes = Buffer.byteLength(publicText, 'utf8')
      if (publicBytes > authority.limits.maxPublicBytes) return { ok: false, reason: 'LIMIT' }
      if (candidate.sourceKind === 'meeting' && !parseMeetingDocument(publicText))
        return { ok: false, reason: 'UNAVAILABLE' }
      const confidentialDisposition = hasMeetingFlag(publicText, 'confidential') ? 'confidential' : 'clear'
      if (confidentialDisposition === 'confidential') {
        if (signal?.aborted) return { ok: false, reason: 'UNAVAILABLE' }
        return {
          ok: true,
          metadata: {
            logicalPath: candidate.logicalPath,
            sourceKind: candidate.sourceKind,
            sourceVersion: candidate.expectedVersion,
            confidentialDisposition,
            sourceBytes,
            publicBytes: 0
          }
        }
      }
      let output: Uint8Array
      try {
        output = new TextEncoder().encode(publicText)
      } catch {
        return { ok: false, reason: 'LIMIT' }
      }
      try {
        for (let offset = 0; offset < output.byteLength; offset += authority.limits.maxChunkBytes) {
          if (signal?.aborted) return { ok: false, reason: 'UNAVAILABLE' }
          if (!current(ownerToken, authority)) return { ok: false, reason: 'STALE_OWNER' }
          const chunk = output.slice(offset, Math.min(output.byteLength, offset + authority.limits.maxChunkBytes))
          try {
            await sink(chunk)
          } catch {
            return { ok: false, reason: 'UNAVAILABLE' }
          }
          if (signal?.aborted) return { ok: false, reason: 'UNAVAILABLE' }
        }
      } finally {
        output.fill(0)
      }
      if (signal?.aborted) return { ok: false, reason: 'UNAVAILABLE' }
      if (!current(ownerToken, authority)) return { ok: false, reason: 'STALE_OWNER' }
      return {
        ok: true,
        metadata: {
          logicalPath: candidate.logicalPath,
          sourceKind: candidate.sourceKind,
          sourceVersion: candidate.expectedVersion,
          confidentialDisposition,
          sourceBytes,
          publicBytes
        }
      }
    }
  }
}

function codedFailure(code: MeetingProjectionRefusal): Error {
  const error = new Error('Projection authority or source limit changed.') as NodeJS.ErrnoException
  error.code = code
  return error
}

let configuredReader: MeetingPublicProjectionReader | undefined
let configuredGeneration = 0

/** Root installs the current-owner reader and explicit limits during main bootstrap; absent wiring is closed. */
export function configureMeetingPublicProjectionReader(
  dependencies: MeetingPublicProjectionDependencies | undefined
): void {
  configuredGeneration += 1
  const generation = configuredGeneration
  configuredReader = dependencies
    ? createMeetingPublicProjectionReader({
        ...dependencies,
        readAuthority: (ownerToken) =>
          generation === configuredGeneration ? dependencies.readAuthority(ownerToken) : undefined
      })
    : undefined
}

export const meetingPublicProjectionReader: MeetingPublicProjectionReader = {
  admit(ownerToken, candidates) {
    return (
      configuredReader?.admit(ownerToken, candidates) ?? Promise.resolve({ ok: false, reason: 'UNAVAILABLE' as const })
    )
  },
  project(ownerToken, handle, sink, signal) {
    return (
      configuredReader?.project(ownerToken, handle, sink, signal) ??
      Promise.resolve({ ok: false, reason: 'UNAVAILABLE' as const })
    )
  }
}
