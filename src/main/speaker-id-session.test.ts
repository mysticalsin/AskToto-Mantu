import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))
vi.mock('./logger', () => ({
  mainLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auditLog: vi.fn()
}))

import {
  createSpeakerId,
  type SpeakerEnrollmentSnapshot
} from './speaker-id'

function embeddingFor(axis: number): Float32Array {
  const embedding = new Float32Array(8)
  embedding[axis] = 1
  embedding[7] = 0.1
  return embedding
}

function windowFor(axis: number): Float32Array {
  return Float32Array.from([axis])
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'speaker-id-session-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function makeId(options: { now?: () => number; compute?: (samples: Float32Array) => Promise<Float32Array | null> } = {}) {
  return createSpeakerId({
    createExtractor: () => ({
      compute: options.compute ?? (async (samples) => samples.length ? embeddingFor(Math.round(samples[0])) : null)
    }),
    storePath: () => join(dir, 'voiceprints.json'),
    now: options.now
  })
}

describe('keyed transient speaker sessions', () => {
  it('keeps interleaved live and import clustering independent', async () => {
    const id = makeId()
    expect(id.createSession('live:100')).toBe(true)
    expect(id.createSession('import:job-a')).toBe(true)

    await expect(id.labelSessionWindow('live:100', windowFor(0), 'live'))
      .resolves.toMatchObject({ name: 'Speaker 1' })
    await expect(id.labelSessionWindow('live:100', windowFor(1), 'live'))
      .resolves.toMatchObject({ name: 'Speaker 2' })
    await expect(id.labelSessionWindow('import:job-a', windowFor(1), 'import'))
      .resolves.toMatchObject({ name: 'Speaker 1' })
    await expect(id.labelSessionWindow('import:job-a', windowFor(0), 'import'))
      .resolves.toMatchObject({ name: 'Speaker 2' })

    expect(id.finalizeSessionByKey('live:100')).toEqual(new Map([
      ['Speaker 1', 'Speaker 1'],
      ['Speaker 2', 'Speaker 2']
    ]))
    expect(id.finalizeSessionByKey('import:job-a')).toEqual(new Map([
      ['Speaker 1', 'Speaker 1'],
      ['Speaker 2', 'Speaker 2']
    ]))
  })

  it('treats the explicit key as authoritative across long silence without recycling transcript labels', async () => {
    let time = 10_000
    const id = makeId({ now: () => time })
    expect(id.createSession('import:long-job')).toBe(true)
    for (let i = 0; i < 3; i++) {
      await expect(id.labelSessionWindow('import:long-job', windowFor(0), 'import'))
        .resolves.toMatchObject({ name: 'Speaker 1' })
    }

    time += 30 * 60_000 + 1
    for (let i = 0; i < 3; i++) {
      await expect(id.labelSessionWindow('import:long-job', windowFor(1), 'import'))
        .resolves.toMatchObject({ name: 'Speaker 2' })
    }

    const snapshot = id.snapshotSession('import:long-job')!
    expect(id.enrollFromSnapshot(snapshot, [
      { clusterLabel: 'Speaker 1', name: 'Alice' },
      { clusterLabel: 'Speaker 2', name: 'Bob' }
    ])).toBe(2)
    expect(new Set(id.listProfiles().map((profile) => profile.name))).toEqual(new Set(['Alice', 'Bob']))
  })

  it('same-key replacement revokes old label and operator continuations', async () => {
    const pending: Array<(embedding: Float32Array) => void> = []
    let calls = 0
    const id = makeId({
      compute: async (samples) => {
        calls++
        if (calls <= 2) return new Promise<Float32Array>((resolve) => { pending.push(resolve) })
        return embeddingFor(Math.round(samples[0]))
      }
    })
    expect(id.createSession('live:100')).toBe(true)
    const staleLabel = id.labelSessionWindow('live:100', windowFor(0), 'live')
    const staleOperator = id.observeSessionOperatorWindow('live:100', windowFor(0), 'live')
    await Promise.resolve()

    expect(id.createSession('live:100')).toBe(true)
    for (const resolve of pending) resolve(embeddingFor(0))

    await expect(staleLabel).resolves.toBeNull()
    await expect(staleOperator).resolves.toBeUndefined()
    await expect(id.labelSessionWindow('live:100', windowFor(1), 'live'))
      .resolves.toMatchObject({ name: 'Speaker 1' })
  })

  it('dispose and snapshot each revoke an exact pending continuation', async () => {
    const pending: Array<(embedding: Float32Array) => void> = []
    let calls = 0
    const id = makeId({
      compute: async (samples) => {
        calls++
        if (calls >= 4) return new Promise<Float32Array>((resolve) => { pending.push(resolve) })
        return embeddingFor(Math.round(samples[0]))
      }
    })

    expect(id.createSession('live:dispose')).toBe(true)
    calls = 3
    const disposed = id.labelSessionWindow('live:dispose', windowFor(4), 'live')
    expect(id.disposeSession('live:dispose')).toBe(true)
    pending.shift()!(embeddingFor(4))
    await expect(disposed).resolves.toBeNull()

    calls = 0
    expect(id.createSession('live:snapshot')).toBe(true)
    for (let i = 0; i < 3; i++) await id.labelSessionWindow('live:snapshot', windowFor(2), 'live')
    const late = id.labelSessionWindow('live:snapshot', windowFor(5), 'live')
    await Promise.resolve()
    const snapshot = id.snapshotSession('live:snapshot')!
    pending.shift()!(embeddingFor(5))
    await expect(late).resolves.toBeNull()
    expect(id.enrollFromSnapshot(snapshot, [
      { clusterLabel: 'Speaker 1', name: 'Retained' },
      { clusterLabel: 'Speaker 2', name: 'Late' }
    ])).toBe(1)
    expect(id.listProfiles()).toEqual([{ name: 'Retained', samples: 3 }])
  })

  it('rejects unsafe keys and refuses a fifth live session without evicting active work', async () => {
    const compute = vi.fn(async (samples: Float32Array) => embeddingFor(Math.round(samples[0])))
    const id = makeId({ compute })
    for (const key of ['', '   ', 'bad\nkey', 'x'.repeat(161)]) {
      expect(id.createSession(key)).toBe(false)
      await expect(id.labelSessionWindow(key, windowFor(0), 'live')).resolves.toBeNull()
    }
    await expect(id.labelSessionWindow('import:missing', windowFor(0), 'import')).resolves.toBeNull()
    for (let i = 0; i < 4; i++) expect(id.createSession(`import:${i}`)).toBe(true)
    expect(id.createSession('import:overflow')).toBe(false)
    await expect(id.labelSessionWindow('import:overflow', windowFor(0), 'import')).resolves.toBeNull()
    await expect(id.labelSessionWindow('import:0', windowFor(0), 'import'))
      .resolves.toMatchObject({ name: 'Speaker 1' })
    expect(compute).toHaveBeenCalledTimes(1)

    expect(id.disposeSession('import:1')).toBe(true)
    expect(id.createSession('import:overflow')).toBe(true)
  })

  it('moves buffered vectors into a one-shot identity token for delayed enrollment', async () => {
    const id = makeId()
    expect(id.createSession('live:100')).toBe(true)
    for (let i = 0; i < 3; i++) {
      await id.labelSessionWindow('live:100', windowFor(2), 'live')
    }

    const snapshot = id.snapshotSession('live:100')
    expect(snapshot).not.toBeNull()
    await expect(id.labelSessionWindow('live:100', windowFor(2), 'live')).resolves.toBeNull()
    expect(id.enrollFromSnapshot(snapshot!, [{ clusterLabel: 'Speaker 1', name: 'Jane Doe' }])).toBe(1)
    expect(id.enrollFromSnapshot(snapshot!, [{ clusterLabel: 'Speaker 1', name: 'Wrong retry' }])).toBe(0)
    expect(id.listProfiles()).toEqual([{ name: 'Jane Doe', samples: 3 }])

    const forged = {} as SpeakerEnrollmentSnapshot
    expect(id.enrollFromSnapshot(forged, [{ clusterLabel: 'Speaker 1', name: 'Forged' }])).toBe(0)
  })

  it('revokes a closed snapshot if its exact session key is explicitly reused', async () => {
    const id = makeId()
    expect(id.createSession('live:100')).toBe(true)
    for (let i = 0; i < 3; i++) await id.labelSessionWindow('live:100', windowFor(2), 'live')
    const snapshot = id.snapshotSession('live:100')!

    expect(id.createSession('live:100')).toBe(true)
    expect(id.enrollFromSnapshot(snapshot, [{ clusterLabel: 'Speaker 1', name: 'Stale meeting' }])).toBe(0)
  })

  it('revokes the oldest fifth snapshot and lazily expires snapshots after 30 minutes', async () => {
    let time = 10_000
    const id = makeId({ now: () => time })
    const snapshots: SpeakerEnrollmentSnapshot[] = []
    for (let i = 0; i < 5; i++) {
      expect(id.createSession(`import:${i}`)).toBe(true)
      for (let n = 0; n < 3; n++) await id.labelSessionWindow(`import:${i}`, windowFor(i), 'import')
      snapshots.push(id.snapshotSession(`import:${i}`)!)
    }

    expect(id.enrollFromSnapshot(snapshots[0], [{ clusterLabel: 'Speaker 1', name: 'Evicted' }])).toBe(0)
    expect(id.enrollFromSnapshot(snapshots[1], [{ clusterLabel: 'Speaker 1', name: 'Retained' }])).toBe(1)

    time += 30 * 60_000 + 1
    expect(id.enrollFromSnapshot(snapshots[4], [{ clusterLabel: 'Speaker 1', name: 'Expired' }])).toBe(0)
    expect(id.listProfiles()).toEqual([{ name: 'Retained', samples: 3 }])
  })

  it('global discard revokes all keyed continuations and snapshots and frees capacity', async () => {
    const pending: Array<(embedding: Float32Array) => void> = []
    const id = makeId({
      compute: () => new Promise<Float32Array>((resolve) => { pending.push(resolve) })
    })
    for (let i = 0; i < 4; i++) expect(id.createSession(`live:${i}`)).toBe(true)
    const stale = id.labelSessionWindow('live:0', windowFor(0), 'live')
    await Promise.resolve()
    id.discardSession()
    pending.shift()!(embeddingFor(0))

    await expect(stale).resolves.toBeNull()
    expect(id.createSession('live:fresh')).toBe(true)

    const complete = makeId()
    expect(complete.createSession('import:a')).toBe(true)
    for (let i = 0; i < 3; i++) await complete.labelSessionWindow('import:a', windowFor(1), 'import')
    const snapshot = complete.snapshotSession('import:a')!
    complete.discardSession()
    expect(complete.enrollFromSnapshot(snapshot, [{ clusterLabel: 'Speaker 1', name: 'Revoked' }])).toBe(0)
  })

  it('shares one extractor and profile repository across isolated sessions', async () => {
    const createExtractor = vi.fn(() => ({
      compute: async (samples: Float32Array) => embeddingFor(Math.round(samples[0]))
    }))
    const id = createSpeakerId({
      createExtractor,
      storePath: () => join(dir, 'voiceprints.json')
    })
    expect(id.createSession('live:a')).toBe(true)
    expect(id.createSession('import:b')).toBe(true)
    for (let i = 0; i < 3; i++) await id.labelSessionWindow('live:a', windowFor(3), 'live')
    const snapshot = id.snapshotSession('live:a')!
    expect(id.enrollFromSnapshot(snapshot, [{ clusterLabel: 'Speaker 1', name: 'Jane Doe' }])).toBe(1)

    await expect(id.labelSessionWindow('import:b', windowFor(3), 'import'))
      .resolves.toMatchObject({ name: 'Jane Doe', source: 'profile' })
    expect(createExtractor).toHaveBeenCalledTimes(1)
  })

  it('snapshotting a normal terminal session flushes its qualified operator buffer', async () => {
    const id = makeId()
    expect(id.createSession('live:a')).toBe(true)
    for (let i = 0; i < 3; i++) await id.observeSessionOperatorWindow('live:a', windowFor(4), 'live')
    expect(id.snapshotSession('live:a')).not.toBeNull()

    const fresh = makeId()
    expect(fresh.createSession('live:b')).toBe(true)
    await expect(fresh.labelSessionWindow('live:b', windowFor(4), 'live'))
      .resolves.toMatchObject({ echo: true })
  })
})
