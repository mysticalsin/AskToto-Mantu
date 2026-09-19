import { describe, expect, it } from 'vitest'
import { cloudSttRequestBelongsToOwner, replaceCloudSttSessionIfCurrent } from './session-replacement'

type ReplacementResult =
  | { ok: true; owner: string }
  | { ok: false; error: string; code: string }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

describe('replaceCloudSttSessionIfCurrent', () => {
  it('does not start a stale owner after a newer owner replaces it during stop', async () => {
    const firstStop = deferred<void>()
    let currentOwner = 'first'
    const starts: string[] = []

    const first = replaceCloudSttSessionIfCurrent<ReplacementResult>({
      stop: () => firstStop.promise,
      isCurrent: () => currentOwner === 'first',
      start: async () => {
        starts.push('first')
        return { ok: true as const, owner: 'first' }
      },
      stale: () => ({ ok: false as const, error: 'replaced', code: 'STALE' })
    })

    await Promise.resolve()
    currentOwner = 'second'
    const second = await replaceCloudSttSessionIfCurrent<ReplacementResult>({
      stop: async () => {},
      isCurrent: () => currentOwner === 'second',
      start: async () => {
        starts.push('second')
        return { ok: true as const, owner: 'second' }
      },
      stale: () => ({ ok: false as const, error: 'replaced', code: 'STALE' })
    })
    firstStop.resolve()

    await expect(first).resolves.toEqual({ ok: false, error: 'replaced', code: 'STALE' })
    expect(second).toEqual({ ok: true, owner: 'second' })
    expect(starts).toEqual(['second'])
  })

  it('maps a session that is superseded while opening to STALE without closing the newer owner', async () => {
    const firstStart = deferred<{ ok: true; owner: string }>()
    let currentOwner = 'first'
    const first = replaceCloudSttSessionIfCurrent<ReplacementResult>({
      stop: async () => {},
      isCurrent: () => currentOwner === 'first',
      start: () => firstStart.promise,
      stale: () => ({ ok: false as const, error: 'replaced', code: 'STALE' })
    })

    await Promise.resolve()
    currentOwner = 'second'
    firstStart.resolve({ ok: true, owner: 'first' })

    await expect(first).resolves.toEqual({ ok: false, error: 'replaced', code: 'STALE' })
  })
})

describe('cloudSttRequestBelongsToOwner', () => {
  it('rejects a delayed old PCM push or unscoped request after the same renderer starts a newer identified session', () => {
    expect(cloudSttRequestBelongsToOwner('listen:2', 'listen:1')).toBe(false)
    expect(cloudSttRequestBelongsToOwner('listen:2', undefined)).toBe(false)
    expect(cloudSttRequestBelongsToOwner('listen:2', 'listen:2')).toBe(true)
  })

  it('allows only the bounded no-id legacy path for an owner that was also created without an id', () => {
    expect(cloudSttRequestBelongsToOwner(undefined, undefined)).toBe(true)
    expect(cloudSttRequestBelongsToOwner(undefined, 'listen:1')).toBe(false)
  })
})
