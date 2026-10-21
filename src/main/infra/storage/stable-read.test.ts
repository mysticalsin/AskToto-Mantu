import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { closeSync, fstatSync, openSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { canonicalSourceRootId } from '../../brain/inputs'
import { atomicSavedWrite } from './atomic-saved-write'
import { activePathLaneCountForTests, withPathLane } from './path-lane'
import { canonicalPath, readStableRegularFile, readStableSnapshotBytes } from './stable-read'

const hooks = vi.hoisted(() => ({
  /** Only handles opened on this exact path are observed; every other open is untouched. */
  watched: undefined as string | undefined,
  afterFirstStat: undefined as (() => Promise<void>) | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
  onClose: undefined as ((fd: number, closeReal: () => Promise<void>) => Promise<void>) | undefined,
  events: [] as string[]
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const observe = (handle: FileHandle): FileHandle => {
    let stats = 0
    return new Proxy(handle, {
      get(target, property) {
        if (property === 'stat')
          return async (...args: Parameters<FileHandle['stat']>) => {
            const result = await target.stat(...args)
            if (++stats === 1) await hooks.afterFirstStat?.()
            return result
          }
        if (property === 'read')
          return async (...args: unknown[]) => {
            const result = await (target.read as (...a: unknown[]) => Promise<unknown>)(...args)
            hooks.events.push('bytes-read')
            await hooks.afterRead?.()
            return result
          }
        if (property === 'close')
          return async () => {
            if (hooks.onClose) return hooks.onClose(target.fd, () => target.close())
            return target.close()
          }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      }
    })
  }
  return {
    ...original,
    open: async (path: Parameters<typeof original.open>[0], ...rest: unknown[]) => {
      const handle = await (original.open as (...a: unknown[]) => Promise<FileHandle>)(path, ...rest)
      return path === hooks.watched ? observe(handle) : handle
    },
    rename: async (from: string, to: string) => {
      hooks.events.push('rename')
      return original.rename(from, to)
    }
  }
})

const LINK_DIR_TYPE = process.platform === 'win32' ? 'junction' : 'dir'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let dir: string
let outside: string
let link: string

beforeEach(async () => {
  hooks.watched = undefined
  hooks.afterFirstStat = undefined
  hooks.afterRead = undefined
  hooks.onClose = undefined
  hooks.events.length = 0
  dir = await mkdtemp(join(tmpdir(), 'metis-stable-read-'))
  outside = await mkdtemp(join(tmpdir(), 'metis-stable-outside-'))
  link = `${dir}-link`
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
  await rm(link, { recursive: true, force: true })
})

describe('stable-read canonical identity', () => {
  it('resolves a plain directory to the same path as fs.promises.realpath', async () => {
    expect(await canonicalPath(dir)).toBe(await realpath(dir))
  })

  it('resolves a symlinked directory to the same path as fs.promises.realpath', async () => {
    await symlink(dir, link, LINK_DIR_TYPE)
    expect(await canonicalPath(link)).toBe(await realpath(dir))
    expect(await canonicalPath(link)).toBe(await realpath(link))
  })

  it('returns null for a path that cannot be resolved', async () => {
    expect(await canonicalPath(join(dir, 'missing'))).toBeNull()
  })

  it('hashes to the same root id that receipt stamping produces', async () => {
    const canonical = await canonicalPath(dir)
    expect(canonical).not.toBeNull()
    expect(createHash('sha256').update(canonical!, 'utf8').digest('hex')).toBe(await canonicalSourceRootId(dir))
  })

  it('reads a regular file and reports the async canonical root', async () => {
    const content = Buffer.from('hello\n')
    await writeFile(join(dir, 'a.md'), content)
    const read = await readStableRegularFile(dir, 'a.md', 1024)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.canonicalRoot).toBe(await realpath(dir))
    expect(read.bytes.equals(content)).toBe(true)
  })

  it('refuses a symlinked file even when its target is inside the root', async () => {
    await writeFile(join(dir, 'a.md'), Buffer.from('hello\n'))
    await symlink(join(dir, 'a.md'), join(dir, 'link.md'), 'file')
    expect((await readStableRegularFile(dir, 'a.md', 1024)).status).toBe('ok')
    expect(await readStableRegularFile(dir, 'link.md', 1024)).toEqual({ status: 'refused' })
  })

  it('refuses a path escaping the root', async () => {
    await writeFile(join(outside, 'x.md'), Buffer.from('outside\n'))
    const escaping = relative(dir, join(outside, 'x.md'))
    expect(await readStableRegularFile(dir, escaping, 1024)).toEqual({ status: 'refused' })
  })
})

describe('stable-read refusals', () => {
  it('refuses empty, oversize, missing and non-regular files', async () => {
    await writeFile(join(dir, 'empty.md'), '')
    await writeFile(join(dir, 'big.md'), Buffer.alloc(33, 1))
    await mkdir(join(dir, 'folder'))
    expect(await readStableRegularFile(dir, 'empty.md', 1024)).toEqual({ status: 'refused' })
    expect(await readStableRegularFile(dir, 'big.md', 32)).toEqual({ status: 'refused' })
    expect(await readStableRegularFile(dir, 'missing.md', 1024)).toEqual({ status: 'refused' })
    expect(await readStableRegularFile(dir, 'folder', 1024)).toEqual({ status: 'refused' })
    expect(await readStableSnapshotBytes(dir, join(dir, 'empty.md'), 1024)).toBeNull()
    expect(await readStableSnapshotBytes(dir, join(dir, 'big.md'), 32)).toBeNull()
    expect(await readStableSnapshotBytes(dir, join(dir, 'missing.md'), 1024)).toBeNull()
    expect(await readStableSnapshotBytes(dir, join(dir, 'folder'), 1024)).toBeNull()
  })

  it('snapshot: reads a file inside the root and refuses symlinks and paths outside it', async () => {
    const content = Buffer.from('{"a":1}\n')
    await writeFile(join(dir, 'a.json'), content)
    await writeFile(join(outside, 'x.json'), content)
    await symlink(join(dir, 'a.json'), join(dir, 'link.json'), 'file')
    expect((await readStableSnapshotBytes(dir, join(dir, 'a.json'), 1024))?.equals(content)).toBe(true)
    expect(await readStableSnapshotBytes(dir, join(dir, 'link.json'), 1024)).toBeNull()
    expect(await readStableSnapshotBytes(dir, join(outside, 'x.json'), 1024)).toBeNull()
  })

  for (const reader of ['regular', 'snapshot'] as const) {
    it(`${reader}: refuses when an external writer changes the file after the identity check`, async () => {
      const file = join(dir, 'fixture.txt')
      await writeFile(file, 'original bytes\n')
      hooks.watched = file
      hooks.afterFirstStat = async () => {
        await appendFile(file, 'external writer\n')
      }
      if (reader === 'regular') expect(await readStableRegularFile(dir, 'fixture.txt', 1024)).toEqual({ status: 'refused' })
      else expect(await readStableSnapshotBytes(dir, file, 1024)).toBeNull()
    })
  }
})

describe('stable-read descriptor closure', () => {
  const content = Buffer.from('disposable stable-read close regression\n')
  let file: string
  let version: { dev: number; ino: number }
  let failClose: boolean
  let mutateAfterRead: boolean
  let observations: {
    fd: number
    owned: boolean
    realCloseReturned: boolean
    postClose: string
    syntheticError: string | null
  }[]

  beforeEach(async () => {
    file = join(dir, 'fixture.txt')
    await writeFile(file, content, { flag: 'wx', mode: 0o600 })
    const { dev, ino } = fstatOf(file)
    version = { dev, ino }
    failClose = false
    mutateAfterRead = false
    observations = []
    hooks.watched = file
    hooks.afterRead = async () => {
      if (mutateAfterRead) await appendFile(file, 'changed after read')
    }
    hooks.onClose = async (fd, closeReal) => {
      const event = {
        fd,
        owned: false,
        realCloseReturned: false,
        postClose: 'NOT_CHECKED',
        syntheticError: null as string | null
      }
      observations.push(event)
      const descriptor = fstatSync(fd)
      event.owned = descriptor.isFile() && descriptor.dev === version.dev && descriptor.ino === version.ino
      if (!event.owned) throw new Error('unowned regression descriptor')
      await closeReal()
      event.realCloseReturned = true
      try {
        fstatSync(fd)
        event.postClose = 'STILL_OPEN'
      } catch (error) {
        event.postClose = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      }
      if (event.postClose !== 'EBADF') throw new Error('regression descriptor closure not confirmed')
      if (failClose) {
        event.syntheticError = 'EIO'
        throw Object.assign(new Error('synthetic close EIO after actual close'), { code: 'EIO' })
      }
    }
  })

  afterEach(() => {
    // Emergency cleanup only owns descriptors still pointing at this disposable fixture.
    for (const event of observations) {
      if (!event.owned || event.postClose === 'EBADF') continue
      try {
        const current = fstatSync(event.fd)
        if (current.dev === version.dev && current.ino === version.ino) closeSync(event.fd)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error
      }
    }
  })

  /** The fixture is closed immediately; only its dev/ino identity is kept. */
  function fstatOf(path: string): { dev: number; ino: number } {
    const fd = openSync(path, 'r')
    try {
      const { dev, ino } = fstatSync(fd)
      return { dev, ino }
    } finally {
      closeSync(fd)
    }
  }

  for (const reader of ['regular', 'snapshot'] as const) {
    for (const closeFails of [false, true]) {
      for (const changed of [false, true]) {
        it(`${reader}: ${changed ? 'changed file refuses' : 'healthy file'} with ${closeFails ? 'close EIO' : 'successful close'}`, async () => {
          failClose = closeFails
          mutateAfterRead = changed
          const result =
            reader === 'regular'
              ? await readStableRegularFile(dir, 'fixture.txt', 1024)
              : await readStableSnapshotBytes(dir, file, 1024)

          expect(observations).toHaveLength(1)
          expect(observations[0]).toMatchObject({
            owned: true,
            realCloseReturned: true,
            postClose: 'EBADF',
            syntheticError: closeFails ? 'EIO' : null
          })
          if (changed) expect(await readFile(file)).toEqual(Buffer.concat([content, Buffer.from('changed after read')]))
          if (closeFails || changed) {
            if (reader === 'regular') expect(result).toEqual({ status: 'refused' })
            else expect(result).toBeNull()
          } else if (reader === 'regular') {
            expect(result).toEqual({ status: 'ok', bytes: content, canonicalRoot: await realpath(dir) })
          } else {
            expect(result).toEqual(content)
          }
        })
      }
    }
  }
})

describe('stable-read in-process write ordering', () => {
  const original = Buffer.from('original saved bytes\n')
  const replacement = Buffer.from('replacement saved bytes\n')

  for (const reader of ['regular', 'snapshot'] as const) {
    it(`${reader}: an in-process atomic write cannot land between the identity check and the byte read`, async () => {
      const file = join(dir, 'fixture.txt')
      await writeFile(file, original)
      hooks.watched = file
      let writing: Promise<void> | undefined
      hooks.afterFirstStat = async () => {
        // The reader has checked identity and holds the descriptor. Start an in-process write now and give
        // it ample time to reach its rename; without the shared lane it would replace the file right here.
        writing = atomicSavedWrite(file, replacement)
        await sleep(100)
      }

      const result =
        reader === 'regular'
          ? await readStableRegularFile(dir, 'fixture.txt', 1024)
          : await readStableSnapshotBytes(dir, file, 1024)
      const bytes = reader === 'regular' ? (result as { bytes?: Buffer }).bytes : (result as Buffer | null)

      expect(bytes?.equals(original)).toBe(true)
      await writing
      expect(hooks.events).toEqual(['bytes-read', 'rename'])
      expect((await readFile(file)).equals(replacement)).toBe(true)
      expect(activePathLaneCountForTests()).toBe(0)
    })
  }

  it('a read that starts after an in-flight write sees the new bytes, never a mix', async () => {
    const file = join(dir, 'fixture.txt')
    await writeFile(file, original)
    const write = atomicSavedWrite(file, replacement)
    const read = await readStableSnapshotBytes(dir, file, 1024)
    await write
    expect(read === null || read.equals(original) || read.equals(replacement)).toBe(true)
    expect((await readStableSnapshotBytes(dir, file, 1024))?.equals(replacement)).toBe(true)
  })

  it('a refused write admission releases the lane so later reads proceed', async () => {
    const file = join(dir, 'fixture.txt')
    await writeFile(file, original)
    await expect(
      atomicSavedWrite(file, replacement, () => {
        throw new Error('admission refused')
      })
    ).rejects.toThrow('admission refused')
    expect(activePathLaneCountForTests()).toBe(0)
    expect((await readStableSnapshotBytes(dir, file, 1024))?.equals(original)).toBe(true)
  })
})

describe('path lane', () => {
  it('runs holders of one path in order and releases the lane after a throw', async () => {
    const order: string[] = []
    const first = withPathLane(dir, async () => {
      order.push('first-start')
      await sleep(30)
      order.push('first-end')
      throw new Error('first failed')
    })
    const second = withPathLane(dir, async () => {
      order.push('second')
    })
    await expect(first).rejects.toThrow('first failed')
    await second
    expect(order).toEqual(['first-start', 'first-end', 'second'])
    expect(activePathLaneCountForTests()).toBe(0)
  })

  it('does not serialize different paths', async () => {
    const order: string[] = []
    const slow = withPathLane(join(dir, 'a'), async () => {
      await sleep(40)
      order.push('slow')
    })
    await withPathLane(join(dir, 'b'), async () => {
      order.push('fast')
    })
    await slow
    expect(order).toEqual(['fast', 'slow'])
  })
})
