import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const closeFixture = vi.hoisted(() => ({
  rejectAfterClose: false,
  stableParentPath: null as string | null,
  stableParentSnapshot: null as unknown,
  stableParentReads: 0,
  appearPath: null as string | null,
  targetLstatCount: 0,
  onSecondTargetLstat: null as (() => void) | null
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const path = String(args[0])
      if (closeFixture.appearPath === path) {
        closeFixture.targetLstatCount += 1
        if (closeFixture.targetLstatCount === 2) closeFixture.onSecondTargetLstat?.()
      }
      const stats = await actual.lstat(...args)
      if (closeFixture.stableParentPath === path) {
        closeFixture.stableParentReads += 1
        closeFixture.stableParentSnapshot ??= stats
        return closeFixture.stableParentSnapshot as typeof stats
      }
      return stats
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'close')
            return async () => {
              await handle.close()
              if (closeFixture.rejectAfterClose) throw new Error('injected close failure')
            }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }
  }
})
import { assertBoundedTextReadCurrent, readBoundedTextFile } from './auth-speech-boundary-readers'

const roots: string[] = []
function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'auth-source-pin-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  closeFixture.stableParentPath = null
  closeFixture.stableParentSnapshot = null
  closeFixture.stableParentReads = 0
  closeFixture.appearPath = null
  closeFixture.targetLstatCount = 0
  closeFixture.onSecondTargetLstat = null
})

describe('bounded auth source pins', () => {
  it('retains membership on the exact read object and refuses a structural clone', async () => {
    const root = profile()
    const path = join(root, 'auth-configured.flag')
    writeFileSync(path, '1')
    const read = await readBoundedTextFile(path, 16)
    expect(read.kind).toBe('present')
    await expect(assertBoundedTextReadCurrent(read)).resolves.toBeUndefined()
    await expect(assertBoundedTextReadCurrent({ ...read })).rejects.toThrow()
  })

  it('retires an original present read after a detected byte ABA replacement', async () => {
    const root = profile()
    const path = join(root, 'auth-lkg-config.json')
    writeFileSync(path, '{"clientId":"a"}')
    const read = await readBoundedTextFile(path, 65_536)
    writeFileSync(path, '{"clientId":"b"}')
    writeFileSync(path, '{"clientId":"a"}')
    await expect(assertBoundedTextReadCurrent(read)).rejects.toThrow()
    await expect(assertBoundedTextReadCurrent(read)).rejects.toThrow()
  })

  it('treats verified absence as a pinned state and detects absent to present to absent', async () => {
    const root = profile()
    const path = join(root, 'auth-configured.flag')
    const read = await readBoundedTextFile(path, 16)
    expect(read.kind).toBe('absent')
    writeFileSync(path, '1')
    rmSync(path)
    await expect(assertBoundedTextReadCurrent(read)).rejects.toThrow()
  })

  it('refuses a bounded read when the source appears after absent capture under unchanged ancestor stats', async () => {
    const root = profile()
    const path = join(root, 'appeared-auth-configured.flag')
    closeFixture.stableParentPath = root
    closeFixture.appearPath = path
    closeFixture.onSecondTargetLstat = () => writeFileSync(path, '1')
    const read = await readBoundedTextFile(path, 16)
    expect(read).toEqual({ kind: 'invalid' })
    expect(closeFixture.targetLstatCount).toBeGreaterThanOrEqual(2)
    expect(closeFixture.stableParentReads).toBeGreaterThan(1)
  })

  it('refuses a symlink source', async () => {
    const root = profile()
    const target = join(root, 'target')
    const link = join(root, 'auth-configured.flag')
    writeFileSync(target, '1')
    symlinkSync(target, link)
    expect(await readBoundedTextFile(link, 16)).toEqual({ kind: 'invalid' })
  })

  it('refuses a sticky/LKG read when descriptor close fails', async () => {
    const root = profile()
    const path = join(root, 'auth-lkg-config.json')
    writeFileSync(path, '{}')
    closeFixture.rejectAfterClose = true
    try {
      expect(await readBoundedTextFile(path, 65_536)).toEqual({ kind: 'invalid' })
    } finally {
      closeFixture.rejectAfterClose = false
    }
  })
})
