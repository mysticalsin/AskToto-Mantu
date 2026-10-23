import { describe, expect, it } from 'vitest'
import { ContextManifestSchema } from '@shared/context-manifest'
import { createManifestLog, utf8Bytes } from './manifest'

describe('manifest log', () => {
  it('stores a content-free manifest per turn and returns it to the same owner only', () => {
    let owner: string | null = 'a'
    const log = createManifestLog({ owner: () => owner, now: () => 5, limit: 2 })
    log.record('t1', [
      { origin: 'screen', authority: 'data', sourceId: 'display:1', bytes: 10, via: 'snapshot' },
      { origin: 'user-typed', authority: 'instruction', sourceId: 'prompt', bytes: 3, via: 'ask' }
    ])
    const m = log.get('t1')
    expect(ContextManifestSchema.safeParse(m).success).toBe(true)
    expect(m?.entries.map((e) => e.via)).toEqual(['snapshot', 'ask'])
    owner = 'b'
    expect(log.get('t1')).toBeNull()
    owner = null
    expect(log.get('t1')).toBeNull()
  })

  it('is bounded and clears', () => {
    const log = createManifestLog({ owner: () => 'a', now: () => 1, limit: 2 })
    for (const id of ['t1', 't2', 't3']) log.record(id, [])
    expect(log.get('t1')).toBeNull()
    expect(log.get('t3')).not.toBeNull()
    log.clear()
    expect(log.get('t3')).toBeNull()
  })

  it('keeps one memory record in step with what was dispatched', () => {
    const log = createManifestLog({ owner: () => 'a', now: () => 1 })
    log.record('t1', [{ origin: 'user-typed', authority: 'instruction', sourceId: 'prompt', bytes: 3, via: 'ask' }])
    log.setMemory('t1', 'slice')
    log.setMemory('t1', 'a longer slice')
    expect(log.get('t1')?.entries.map((e) => [e.sourceId, e.bytes])).toEqual([
      ['memory', 14],
      ['prompt', 3]
    ])
    log.setMemory('t1', undefined)
    expect(log.get('t1')?.entries.map((e) => e.sourceId)).toEqual(['prompt'])
    log.setMemory('unknown', 'x')
  })

  it('measures bytes as utf-8', () => {
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes(undefined)).toBe(0)
  })
})
