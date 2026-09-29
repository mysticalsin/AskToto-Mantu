import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWrite, atomicWriteSync, uniqueTmpPath } from './atomic-write'

// Every real call stays real; the spies only observe and, per test, fail the syscall under audit.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: rename`), { code })

describe('atomicWrite', () => {
  let dir: string
  let target: string
  const realRenameSync = vi.mocked(fs.renameSync).getMockImplementation()!
  const realRename = vi.mocked(fsp.rename).getMockImplementation()!

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), 'atomic-write-test-'))
    target = join(dir, 'state.bin')
    vi.mocked(fs.renameSync).mockImplementation(realRenameSync)
    vi.mocked(fsp.rename).mockImplementation(realRename)
    vi.mocked(fs.renameSync).mockClear()
    vi.mocked(fs.fsyncSync).mockClear()
    vi.mocked(fsp.rename).mockClear()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('atomicWriteSync', () => {
    it('creates the target with the bytes and an owner-only mode, leaving no tmp file', () => {
      atomicWriteSync(target, Buffer.from('first'))
      expect(fs.readFileSync(target, 'utf8')).toBe('first')
      expect(fs.readdirSync(dir)).toEqual(['state.bin'])
      if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    })

    it('replaces an existing target', () => {
      fs.writeFileSync(target, 'old')
      atomicWriteSync(target, 'new')
      expect(fs.readFileSync(target, 'utf8')).toBe('new')
    })

    it('fsyncs and completes the tmp file before the rename makes it visible', () => {
      let tmpAtRename: string | null = null
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        tmpAtRename = fs.readFileSync(from, 'utf8')
        expect(fs.existsSync(target)).toBe(false) // the target is not touched before the rename
        realRenameSync(from, to)
      })
      atomicWriteSync(target, 'complete-bytes')
      expect(tmpAtRename).toBe('complete-bytes')
      expect(vi.mocked(fs.fsyncSync)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(fs.fsyncSync).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(fs.renameSync).mock.invocationCallOrder[0]
      )
    })

    it('a crash between the write and the rename leaves the previous bytes intact and no tmp file', () => {
      fs.writeFileSync(target, 'previous')
      vi.mocked(fs.renameSync).mockImplementation(() => {
        throw errno('EIO')
      })
      expect(() => atomicWriteSync(target, 'never-visible')).toThrow('EIO')
      expect(fs.readFileSync(target, 'utf8')).toBe('previous')
      expect(fs.readdirSync(dir)).toEqual(['state.bin'])
      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(1) // EIO is not transient
    })

    it('retries a rename that fails with EPERM or EBUSY, then succeeds', () => {
      let calls = 0
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        if (calls++ < 2) throw errno(calls === 1 ? 'EPERM' : 'EBUSY')
        realRenameSync(from, to)
      })
      atomicWriteSync(target, 'after-retries')
      expect(calls).toBe(3)
      expect(fs.readFileSync(target, 'utf8')).toBe('after-retries')
    })

    it('gives up after bounded retries, keeps the previous bytes and removes the tmp file', () => {
      fs.writeFileSync(target, 'previous')
      vi.mocked(fs.renameSync).mockImplementation(() => {
        throw errno('EPERM')
      })
      expect(() => atomicWriteSync(target, 'blocked')).toThrow('EPERM')
      expect(vi.mocked(fs.renameSync)).toHaveBeenCalledTimes(5)
      expect(fs.readFileSync(target, 'utf8')).toBe('previous')
      expect(fs.readdirSync(dir)).toEqual(['state.bin'])
    })

    it('honours a caller-supplied tmp path', () => {
      const tmp = join(dir, 'custom.tmp')
      vi.mocked(fs.renameSync).mockImplementation((from, to) => {
        expect(from).toBe(tmp)
        realRenameSync(from, to)
      })
      atomicWriteSync(target, 'x', { tmp })
      expect(fs.readFileSync(target, 'utf8')).toBe('x')
    })
  })

  describe('atomicWrite', () => {
    it('writes the bytes through a completed tmp file and leaves none behind', async () => {
      let tmpAtRename: string | null = null
      vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
        tmpAtRename = fs.readFileSync(from as string, 'utf8')
        await realRename(from, to)
      })
      await atomicWrite(target, 'async-bytes')
      expect(tmpAtRename).toBe('async-bytes')
      expect(fs.readFileSync(target, 'utf8')).toBe('async-bytes')
      expect(fs.readdirSync(dir)).toEqual(['state.bin'])
    })

    it('a crash between the write and the rename leaves the previous bytes intact and no tmp file', async () => {
      fs.writeFileSync(target, 'previous')
      vi.mocked(fsp.rename).mockImplementation(async () => {
        throw errno('ENOSPC')
      })
      await expect(atomicWrite(target, 'never-visible')).rejects.toThrow('ENOSPC')
      expect(fs.readFileSync(target, 'utf8')).toBe('previous')
      expect(fs.readdirSync(dir)).toEqual(['state.bin'])
      expect(vi.mocked(fsp.rename)).toHaveBeenCalledTimes(1)
    })

    it('retries a rename that fails once with EPERM', async () => {
      let calls = 0
      vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
        if (calls++ === 0) throw errno('EPERM')
        await realRename(from, to)
      })
      await atomicWrite(target, 'after-retry')
      expect(calls).toBe(2)
      expect(fs.readFileSync(target, 'utf8')).toBe('after-retry')
    })
  })

  it('uniqueTmpPath differs per call and stays beside the target', () => {
    const a = uniqueTmpPath(target)
    const b = uniqueTmpPath(target)
    expect(a).not.toBe(b)
    expect(a.startsWith(`${target}.`) && a.endsWith('.tmp')).toBe(true)
  })
})
