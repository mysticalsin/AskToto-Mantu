import { describe, expect, it, vi } from 'vitest'
import type { FileClass, StorageGateway, StorageStreamResult } from '../../infra/storage/gateway'
import {
  createMeetingPublicProjectionReader,
  type MeetingProjectionAuthority,
  type MeetingProjectionCandidate
} from './meeting-public-projection'

const owner = Object.freeze({ token: true })
const version = Object.freeze({ mtimeMs: 12, ctimeMs: 13, size: 11 })
const candidate: MeetingProjectionCandidate = {
  logicalPath: '2026-10-01_120000-notes.md',
  sourceKind: 'ordinary',
  expectedVersion: version
}
const limits = { maxCandidates: 4, maxSourceBytes: 128, maxPublicBytes: 128, maxChunkBytes: 4 }

function authority(overrides: Partial<MeetingProjectionAuthority> = {}): MeetingProjectionAuthority {
  return {
    root: '/meetings',
    rootIdentity: 'root-generation-1',
    limits,
    ...overrides
  }
}

function fakeGateway(
  options: { fileClass?: FileClass; streamResult?: StorageStreamResult; source?: Uint8Array } = {}
): StorageGateway {
  const source = options.source ?? new TextEncoder().encode('ordinary md')
  const sourceVersion = { ...version, size: source.byteLength }
  return {
    list: async () => ({ status: 'unavailable', code: 'NOT_USED' }),
    classify: async (paths) =>
      new Map(paths.map((path) => [path, options.fileClass ?? { status: 'ok', version: sourceVersion }])),
    read: async () => ({ status: 'unavailable', code: 'NOT_USED' }),
    stream: async (_path, sink, streamLimits) => {
      if (options.streamResult && options.streamResult.status !== 'ok') return options.streamResult
      for (let offset = 0; offset < source.byteLength; offset += streamLimits.maxChunkBytes) {
        const chunk = source.slice(offset, offset + streamLimits.maxChunkBytes)
        await sink(chunk, streamLimits.signal ?? new AbortController().signal)
      }
      return {
        status: 'ok',
        version: sourceVersion,
        bytesRead: source.byteLength,
        chunksRead: Math.ceil(source.byteLength / streamLimits.maxChunkBytes)
      }
    }
  } as StorageGateway
}

function reader(
  options: {
    source?: Uint8Array
    fileClass?: FileClass
    streamResult?: StorageStreamResult
    current?: () => boolean
    rootIdentity?: string
  } = {}
) {
  const gateway = fakeGateway(options)
  const readAuthority = () =>
    options.current?.() === false ? undefined : authority({ rootIdentity: options.rootIdentity })
  return createMeetingPublicProjectionReader({
    readAuthority: (token) => (token === owner ? readAuthority() : undefined),
    gatewayForRoot: () => gateway
  })
}

describe('owned meeting public projection reader', () => {
  it('keeps the process singleton closed until root installs an authority reader', async () => {
    const { meetingPublicProjectionReader } = await import('./meeting-public-projection')
    expect(await meetingPublicProjectionReader.admit(owner, [candidate])).toEqual({ ok: false, reason: 'UNAVAILABLE' })
  })

  it('pins the exact admitted source version and emits bounded public chunks only after validation', async () => {
    const service = reader()
    const admitted = await service.admit(owner, [candidate])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const chunks: Uint8Array[] = []
    const result = await service.project(owner, admitted.handles[0], async (chunk) => chunks.push(chunk))
    expect(result).toEqual({
      ok: true,
      metadata: {
        logicalPath: candidate.logicalPath,
        sourceKind: 'meeting',
        sourceVersion: version,
        confidentialDisposition: 'clear',
        sourceBytes: 11,
        publicBytes: 11
      }
    })
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([4, 4, 3])
    expect(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))).toBe('ordinary md')
  })

  it('rejects unsafe paths, duplicate source identities, and stale classifications', async () => {
    const service = reader({ fileClass: { status: 'dataless', version } })
    expect(await service.admit(owner, [{ ...candidate, logicalPath: '../private.md' }])).toEqual({
      ok: false,
      reason: 'UNAVAILABLE'
    })
    expect(await service.admit(owner, [candidate, candidate])).toEqual({ ok: false, reason: 'UNAVAILABLE' })
    expect(await service.admit(owner, [candidate])).toEqual({ ok: false, reason: 'SOURCE_CHANGED' })
  })

  it('emits no bytes after owner revocation or a post-admission source-version change', async () => {
    let current = true
    const service = reader({ current: () => current })
    const admitted = await service.admit(owner, [candidate])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    current = false
    const chunks: Uint8Array[] = []
    expect(await service.project(owner, admitted.handles[0], (chunk) => chunks.push(chunk))).toEqual({
      ok: false,
      reason: 'STALE_OWNER'
    })
    expect(chunks).toEqual([])
  })

  it('returns confidential disposition without invoking the staged sink', async () => {
    const confidential = new TextEncoder().encode('---\nconfidential: true\n---\nPrivate text')
    const service = reader({ source: confidential })
    const admitted = await service.admit(owner, [
      { ...candidate, sourceKind: 'ordinary', expectedVersion: { ...version, size: confidential.byteLength } }
    ])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const sink = vi.fn()
    expect(await service.project(owner, admitted.handles[0], sink)).toMatchObject({
      ok: true,
      metadata: { confidentialDisposition: 'confidential', publicBytes: 0 }
    })
    expect(sink).not.toHaveBeenCalled()
  })
})
