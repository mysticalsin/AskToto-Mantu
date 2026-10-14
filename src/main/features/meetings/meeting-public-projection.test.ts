import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentVersion, FileClass, StorageGateway, StorageStreamResult } from '../../infra/storage/gateway'

const projectionControl = vi.hoisted(() => ({
  override: undefined as ((text: string) => Promise<string>) | undefined
}))

vi.mock('./meeting-speech', async (importOriginal) => {
  const original = await importOriginal<typeof import('./meeting-speech')>()
  return {
    ...original,
    publicMeetingTextAsync: (text: string) =>
      projectionControl.override ? projectionControl.override(text) : original.publicMeetingTextAsync(text)
  }
})

import {
  configureMeetingPublicProjectionReader,
  createMeetingPublicProjectionReader,
  meetingPublicProjectionReader,
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
  options: {
    fileClass?: FileClass
    streamResult?: StorageStreamResult
    source?: Uint8Array
    streamVersion?: ContentVersion
  } = {}
): StorageGateway {
  const source = options.source ?? new TextEncoder().encode('ordinary md')
  const sourceVersion = { ...version, size: source.byteLength }
  const streamedVersion = options.streamVersion ?? sourceVersion
  return {
    list: async () => ({ status: 'unavailable', code: 'NOT_USED' }),
    classify: async (paths) =>
      new Map(
        paths.map((path) => [
          path,
          options.fileClass ?? { status: 'ok', version: sourceVersion, isSymlink: false, isRegular: true }
        ])
      ),
    read: async () => ({ status: 'unavailable', code: 'NOT_USED' }),
    stream: async (_path, sink, streamLimits) => {
      if (options.streamResult && options.streamResult.status !== 'ok') return options.streamResult
      for (let offset = 0; offset < source.byteLength; offset += streamLimits.maxChunkBytes) {
        const chunk = source.slice(offset, offset + streamLimits.maxChunkBytes)
        await sink(chunk, streamLimits.signal ?? new AbortController().signal)
      }
      return {
        status: 'ok',
        version: streamedVersion,
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
    streamVersion?: ContentVersion
    publicLimit?: number
  } = {}
) {
  const gateway = fakeGateway(options)
  const readAuthority = () =>
    options.current?.() === false
      ? undefined
      : authority({
          rootIdentity: options.rootIdentity ?? 'root-generation-1',
          limits: { ...limits, maxPublicBytes: options.publicLimit ?? limits.maxPublicBytes }
        })
  return createMeetingPublicProjectionReader({
    readAuthority: (token) => (token === owner ? readAuthority() : undefined),
    gatewayForRoot: () => gateway
  })
}

describe('owned meeting public projection reader', () => {
  afterEach(() => {
    projectionControl.override = undefined
    configureMeetingPublicProjectionReader(undefined)
  })

  it('keeps the process singleton closed until root installs an authority reader', async () => {
    configureMeetingPublicProjectionReader(undefined)
    expect(await meetingPublicProjectionReader.admit(owner, [candidate])).toEqual({ ok: false, reason: 'UNAVAILABLE' })
  })

  it('retires an in-flight handle when the root replaces its authority adapter', async () => {
    configureMeetingPublicProjectionReader({
      readAuthority: (token) => (token === owner ? authority() : undefined),
      gatewayForRoot: () => fakeGateway()
    })
    const admitted = await meetingPublicProjectionReader.admit(owner, [candidate])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    let signalStarted!: () => void
    let release!: () => void
    const sinkStarted = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const blockedSink = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = meetingPublicProjectionReader.project(owner, admitted.handles[0], async () => {
      signalStarted()
      await blockedSink
    })
    await sinkStarted
    configureMeetingPublicProjectionReader(undefined)
    release()
    expect(await pending).toEqual({ ok: false, reason: 'STALE_OWNER' })
  })

  it('pins the exact admitted source version and emits bounded public chunks only after validation', async () => {
    const service = reader()
    const admitted = await service.admit(owner, [candidate])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const chunks: Uint8Array[] = []
    const result = await service.project(owner, admitted.handles[0], async (chunk) => {
      chunks.push(chunk)
    })
    expect(result).toEqual({
      ok: true,
      metadata: {
        logicalPath: candidate.logicalPath,
        sourceKind: 'ordinary',
        sourceVersion: version,
        confidentialDisposition: 'clear',
        sourceBytes: 11,
        publicBytes: 11
      }
    })
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([4, 4, 3])
    expect(new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))).toBe('ordinary md')
  })

  it('rejects unsafe paths, duplicate source identities, and unavailable classifications', async () => {
    const service = reader({ fileClass: { status: 'dataless', version, isSymlink: false, isRegular: true } })
    expect(await service.admit(owner, [{ ...candidate, logicalPath: '../private.md' }])).toEqual({
      ok: false,
      reason: 'UNAVAILABLE'
    })
    expect(await service.admit(owner, [candidate, candidate])).toEqual({ ok: false, reason: 'UNAVAILABLE' })
    expect(await service.admit(owner, [candidate])).toEqual({ ok: false, reason: 'UNAVAILABLE' })
  })

  it('emits no bytes after owner revocation', async () => {
    let current = true
    const service = reader({ current: () => current })
    const admitted = await service.admit(owner, [candidate])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    current = false
    const chunks: Uint8Array[] = []
    expect(
      await service.project(owner, admitted.handles[0], (chunk) => {
        chunks.push(chunk)
      })
    ).toEqual({ ok: false, reason: 'STALE_OWNER' })
    expect(chunks).toEqual([])
  })

  it('refuses output when the streamed source version changed after admission', async () => {
    const service = reader({ streamVersion: { ...version, mtimeMs: version.mtimeMs + 1 } })
    const admitted = await service.admit(owner, [candidate])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const sink = vi.fn()
    expect(await service.project(owner, admitted.handles[0], sink)).toEqual({ ok: false, reason: 'SOURCE_CHANGED' })
    expect(sink).not.toHaveBeenCalled()
  })

  it('applies the admitted public byte budget before any sink output', async () => {
    const service = reader({ publicLimit: 5 })
    const admitted = await service.admit(owner, [candidate])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const sink = vi.fn()
    expect(await service.project(owner, admitted.handles[0], sink)).toEqual({ ok: false, reason: 'LIMIT' })
    expect(sink).not.toHaveBeenCalled()
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

  it('refuses after a held worker projection resolves following cancellation', async () => {
    const service = reader()
    const admitted = await service.admit(owner, [candidate])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    let started!: () => void
    let release!: (value: string) => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const held = new Promise<string>((resolve) => {
      release = resolve
    })
    projectionControl.override = async () => {
      started()
      return held
    }
    const controller = new AbortController()
    const sink = vi.fn()
    const pending = service.project(owner, admitted.handles[0], sink, controller.signal)
    await entered
    controller.abort()
    release('ordinary md')

    expect(await pending).toEqual({ ok: false, reason: 'UNAVAILABLE' })
    expect(sink).not.toHaveBeenCalled()
  })

  it('refuses when the final sink aborts while applying the last public chunk', async () => {
    const service = reader({ source: new TextEncoder().encode('last') })
    const admitted = await service.admit(owner, [{ ...candidate, expectedVersion: { ...version, size: 4 } }])
    expect(admitted.ok).toBe(true)
    if (!admitted.ok) return
    const controller = new AbortController()
    const chunks: Uint8Array[] = []

    const result = await service.project(
      owner,
      admitted.handles[0],
      (chunk) => {
        chunks.push(chunk)
        controller.abort()
      },
      controller.signal
    )

    expect(result).toEqual({ ok: false, reason: 'UNAVAILABLE' })
    expect(chunks).toHaveLength(1)
  })
})
