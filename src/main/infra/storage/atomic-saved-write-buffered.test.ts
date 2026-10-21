import { randomBytes } from 'node:crypto'
import { lstat, mkdtemp, open, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { atomicSavedWrite } from './atomic-saved-write'
import { recordLocalWrite } from './local-writes'

vi.mock('node:crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:crypto')>()
  return { ...original, randomBytes: vi.fn(original.randomBytes) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open), rename: vi.fn(original.rename), unlink: vi.fn(original.unlink) }
})
vi.mock('./local-writes', async (importOriginal) => {
  const original = await importOriginal<typeof import('./local-writes')>()
  return { ...original, recordLocalWrite: vi.fn(original.recordLocalWrite) }
})

describe('buffered saved-note replacement', () => {
  let root: string
  let target: string
  let temp: string
  let held: string
  let events: string[]
  let closeCalls: number
  let failure: { stage: 'write' | 'sync' | 'close'; value: unknown } | undefined
  let cleanupCloseFailure: boolean
  let afterWrite: (() => Promise<void>) | undefined
  const bytes = Buffer.from([0, 1, 0xff, 65, 10])
  const old = 'old-destination'
  const foreign = 'foreign-temp'

  beforeEach(async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const crypto = await vi.importActual<typeof import('node:crypto')>('node:crypto')
    const local = await vi.importActual<typeof import('./local-writes')>('./local-writes')
    root = await mkdtemp(join(tmpdir(), 'metis-buffered-save-'))
    target = join(root, 'note.md')
    temp = `${target}.${Buffer.alloc(6, 0x42).toString('hex')}.tmp`
    held = join(root, 'held-owned-temp')
    events = []
    closeCalls = 0
    failure = undefined
    cleanupCloseFailure = false
    afterWrite = undefined
    // Reset factory-created mocks explicitly; restoreAllMocks alone does not reset them.
    vi.mocked(randomBytes)
      .mockReset()
      .mockImplementation(((size: number) =>
        size === 6 ? Buffer.alloc(6, 0x42) : crypto.randomBytes(size)) as typeof randomBytes)
    vi.mocked(unlink).mockReset().mockImplementation(fs.unlink)
    vi.mocked(rename)
      .mockReset()
      .mockImplementation(async (...args) => {
        events.push('rename')
        await fs.rename(...args)
      })
    vi.mocked(recordLocalWrite)
      .mockReset()
      .mockImplementation(async (file) => {
        events.push('publish')
        await local.recordLocalWrite(file)
      })
    vi.mocked(open)
      .mockReset()
      .mockImplementation(async (path, flags, mode) => {
        const handle = await fs.open(path, flags, mode)
        if (flags !== 'wx') return handle
        events.push('open')
        return new Proxy(handle, {
          get(object, key) {
            if (key === 'writeFile')
              return async (...args: Parameters<typeof handle.writeFile>) => {
                events.push('write')
                if (failure?.stage === 'write') throw failure.value
                await object.writeFile(...args)
                await afterWrite?.()
              }
            if (key === 'sync')
              return async () => {
                events.push('sync')
                if (failure?.stage === 'sync') throw failure.value
                await object.sync()
              }
            if (key === 'close')
              return async () => {
                closeCalls++
                events.push('close')
                // Close the actual descriptor even when simulating a close rejection.
                await object.close()
                if (failure?.stage === 'close') throw failure.value
                if (cleanupCloseFailure) throw new Error('synthetic cleanup close failure')
              }
            const value = Reflect.get(object, key, object)
            return typeof value === 'function' ? value.bind(object) : value
          }
        })
      })
    await writeFile(target, old)
  })

  afterEach(async () => {
    try {
      vi.restoreAllMocks()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  async function rejection(operation: Promise<unknown>): Promise<unknown> {
    return operation.then(
      () => {
        throw new Error('Expected the write to reject')
      },
      (error: unknown) => error
    )
  }

  async function assertRefused(): Promise<void> {
    expect(await readFile(target, 'utf8')).toBe(old)
    expect(rename).not.toHaveBeenCalled()
    expect(recordLocalWrite).not.toHaveBeenCalled()
  }

  it('preserves both sentinels on a colliding temporary name', async () => {
    await writeFile(temp, foreign)
    const result = await atomicSavedWrite(target, bytes).then(
      () => undefined,
      (error: unknown) => error
    )
    // On the old writer this fails on real unwanted replacement, not a mock/import timeout.
    expect(await readFile(target, 'utf8')).toBe(old)
    expect(result).toMatchObject({ code: 'EEXIST' })
    expect(await readFile(temp, 'utf8')).toBe(foreign)
    expect(rename).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(recordLocalWrite).not.toHaveBeenCalled()
  })

  it('does not follow or unlink a colliding symlink', async () => {
    const sentinel = join(root, 'foreign-file')
    await writeFile(sentinel, foreign)
    await symlink(sentinel, temp)
    expect(await rejection(atomicSavedWrite(target, bytes))).toMatchObject({ code: 'EEXIST' })
    await assertRefused()
    expect(await readFile(sentinel, 'utf8')).toBe(foreign)
    expect((await lstat(temp)).isSymbolicLink()).toBe(true)
    expect(unlink).not.toHaveBeenCalled()
  })

  it('writes exact bytes with exclusive0600 acquisition and sync/close before admission/replace/publication', async () => {
    await atomicSavedWrite(target, bytes, () => {
      events.push('admit')
    })
    expect(open).toHaveBeenCalledWith(temp, 'wx', 0o600)
    expect(await readFile(target)).toEqual(bytes)
    expect(events).toEqual(['open', 'write', 'sync', 'close', 'admit', 'rename', 'publish'])
    expect(closeCalls).toBe(1)
    expect(recordLocalWrite).toHaveBeenCalledExactlyOnceWith(target)
    expect(unlink).not.toHaveBeenCalled()
    await expect(lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses an observed post-create replacement without deleting the foreign temp', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    afterWrite = async () => {
      await fs.rename(temp, held)
      await fs.writeFile(temp, foreign)
    }
    expect(await rejection(atomicSavedWrite(target, bytes))).toMatchObject({ name: 'TEMP_OWNERSHIP' })
    await assertRefused()
    expect(await readFile(temp, 'utf8')).toBe(foreign)
    expect(await readFile(held)).toEqual(bytes)
    expect(unlink).not.toHaveBeenCalled()
    expect(closeCalls).toBe(1)
  })

  it.each([
    'write',
    'sync',
    'close'
  ] as const)('refuses replacement on %s failure and cleans only its owned temp', async (stage) => {
    const error = new Error(`synthetic ${stage} failure`)
    failure = { stage, value: error }
    expect(await rejection(atomicSavedWrite(target, bytes))).toBe(error)
    await assertRefused()
    expect(closeCalls).toBe(1)
    expect(unlink).toHaveBeenCalledExactlyOnceWith(temp)
    await expect(lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    undefined,
    null,
    new Error('primary write failure')
  ])('retains exact primary write error %s despite close/unlink cleanup failures', async (value) => {
    failure = { stage: 'write', value }
    cleanupCloseFailure = true
    vi.mocked(unlink).mockRejectedValueOnce(new Error('synthetic unlink failure'))
    expect(await rejection(atomicSavedWrite(target, bytes))).toBe(value)
    await assertRefused()
    expect(closeCalls).toBe(1)
    expect(unlink).toHaveBeenCalledExactlyOnceWith(temp)
  })

  it.each([undefined, null])('preserves initial admission refusal %s with cleanup failure', async (value) => {
    vi.mocked(unlink).mockRejectedValueOnce(new Error('synthetic unlink failure'))
    const admit = vi.fn(() => {
      throw value
    })
    expect(await rejection(atomicSavedWrite(target, bytes, admit))).toBe(value)
    expect(admit).toHaveBeenCalledTimes(1)
    await assertRefused()
    expect(closeCalls).toBe(1)
    expect(unlink).toHaveBeenCalledExactlyOnceWith(temp)
  })

  it.each([undefined, null])('preserves later admission refusal %s after one transient rename error', async (value) => {
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
    const admit = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw value
      })
    expect(await rejection(atomicSavedWrite(target, bytes, admit))).toBe(value)
    expect(admit).toHaveBeenCalledTimes(2)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(await readFile(target, 'utf8')).toBe(old)
    expect(recordLocalWrite).not.toHaveBeenCalled()
    expect(unlink).toHaveBeenCalledExactlyOnceWith(temp)
  })

  it.each([
    'EPERM',
    'EBUSY'
  ])('retries %s with the original40/80/160/320ms schedule and five attempts', async (code) => {
    const error = Object.assign(new Error('busy'), { code })
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    vi.mocked(rename)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
    const admit = vi.fn()
    await atomicSavedWrite(target, bytes, admit)
    expect(rename).toHaveBeenCalledTimes(5)
    expect(admit).toHaveBeenCalledTimes(5)
    expect(timeout.mock.calls.map((call) => call[1])).toEqual([40, 80, 160, 320])
    expect(await readFile(target)).toEqual(bytes)
    expect(recordLocalWrite).toHaveBeenCalledExactlyOnceWith(target)
  })

  it.each(['EPERM', 'EBUSY'])('stops after five %s refusals with original failure and owned cleanup', async (code) => {
    const error = Object.assign(new Error('still busy'), { code })
    vi.mocked(rename).mockRejectedValue(error)
    expect(await rejection(atomicSavedWrite(target, bytes))).toBe(error)
    expect(rename).toHaveBeenCalledTimes(5)
    expect(recordLocalWrite).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe(old)
    expect(unlink).toHaveBeenCalledExactlyOnceWith(temp)
  })

  it.each([
    Object.assign(new Error('nontransient'), { code: 'EIO' }),
    undefined,
    null
  ])('does not retry or replace nontransient rename error %s', async (value) => {
    vi.mocked(rename).mockRejectedValue(value)
    expect(await rejection(atomicSavedWrite(target, bytes))).toBe(value)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(recordLocalWrite).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe(old)
    expect(unlink).toHaveBeenCalledExactlyOnceWith(temp)
  })

  it('rechecks temp ownership after the transient retry wait', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    vi.mocked(rename).mockImplementationOnce(async () => {
      await fs.rename(temp, held)
      await fs.writeFile(temp, foreign)
      throw Object.assign(new Error('busy'), { code: 'EBUSY' })
    })
    expect(await rejection(atomicSavedWrite(target, bytes))).toMatchObject({ name: 'TEMP_OWNERSHIP' })
    expect(timeout.mock.calls.map((call) => call[1])).toEqual([40])
    expect(rename).toHaveBeenCalledTimes(1)
    expect(recordLocalWrite).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(await readFile(target, 'utf8')).toBe(old)
    expect(await readFile(temp, 'utf8')).toBe(foreign)
  })

  it('does not treat a replaced destination as cleanup after publication failure', async () => {
    const error = new Error('synthetic publication failure')
    vi.mocked(recordLocalWrite).mockRejectedValueOnce(error)
    expect(await rejection(atomicSavedWrite(target, bytes))).toBe(error)
    expect(await readFile(target)).toEqual(bytes)
    expect(rename).toHaveBeenCalledTimes(1)
    expect(recordLocalWrite).toHaveBeenCalledExactlyOnceWith(target)
    expect(unlink).not.toHaveBeenCalled()
  })
})
