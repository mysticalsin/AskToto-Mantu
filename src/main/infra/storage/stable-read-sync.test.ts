import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { canonicalSourceRootId } from '../../brain/inputs'
import { canonicalPathSync, readStableRegularFileSync } from './stable-read-sync'

const LINK_DIR_TYPE = process.platform === 'win32' ? 'junction' : 'dir'
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')

describe('stable-read-sync canonical identity', () => {
  let dir: string
  let outside: string
  let link: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'metis-stable-read-'))
    outside = await mkdtemp(join(tmpdir(), 'metis-stable-outside-'))
    link = `${dir}-link`
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(link, { recursive: true, force: true })
  })

  it('resolves a plain directory to the same path as fs.promises.realpath', async () => {
    expect(canonicalPathSync(dir)).toBe(await realpath(dir))
  })

  it('resolves a symlinked directory to the same path as fs.promises.realpath', async () => {
    await symlink(dir, link, LINK_DIR_TYPE)
    expect(canonicalPathSync(link)).toBe(await realpath(dir))
    expect(canonicalPathSync(link)).toBe(await realpath(link))
  })

  it('hashes to the same root id that receipt stamping produces', async () => {
    const canonical = canonicalPathSync(dir)
    expect(canonical).not.toBeNull()
    expect(createHash('sha256').update(canonical!, 'utf8').digest('hex')).toBe(await canonicalSourceRootId(dir))
  })

  it('reads a regular file and reports the async canonical root', async () => {
    const content = Buffer.from('hello\n')
    await writeFile(join(dir, 'a.md'), content)
    const read = readStableRegularFileSync(dir, 'a.md', 1024)
    expect(read.status).toBe('ok')
    if (read.status !== 'ok') return
    expect(read.canonicalRoot).toBe(await realpath(dir))
    expect(read.bytes.equals(content)).toBe(true)
  })

  it('refuses a symlinked file even when its target is inside the root', async () => {
    await writeFile(join(dir, 'a.md'), Buffer.from('hello\n'))
    await symlink(join(dir, 'a.md'), join(dir, 'link.md'), 'file')
    expect(readStableRegularFileSync(dir, 'a.md', 1024).status).toBe('ok')
    expect(readStableRegularFileSync(dir, 'link.md', 1024)).toEqual({ status: 'refused' })
  })

  it('refuses a path escaping the root', async () => {
    await writeFile(join(outside, 'x.md'), Buffer.from('outside\n'))
    const escaping = relative(dir, join(outside, 'x.md'))
    expect(readStableRegularFileSync(dir, escaping, 1024)).toEqual({ status: 'refused' })
  })
})

describe('stable-read-sync descriptor closure', () => {
  const content = Buffer.from('disposable stable-read close regression\n')
  let dir: string
  let file: string
  let version: import('node:fs').Stats
  let failClose: boolean
  let mutateAfterRead: boolean
  let observations: {
    fd: number
    owned: boolean
    realCloseReturned: boolean
    postClose: string
    syntheticError: string | null
  }[]

  beforeEach(() => {
    vi.resetModules()
    dir = fs.mkdtempSync(join(tmpdir(), 'metis-stable-close-'))
    file = join(dir, 'fixture.txt')
    fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 })
    version = fs.lstatSync(file)
    failClose = false
    mutateAfterRead = false
    observations = []
    vi.doMock('node:fs', () => ({
      ...fs,
      readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
        const count = fs.readSync(fd, buffer, offset, length, position)
        if (mutateAfterRead) fs.appendFileSync(file, 'changed after read')
        return count
      },
      closeSync(fd: number) {
        const event = {
          fd,
          owned: false,
          realCloseReturned: false,
          postClose: 'NOT_CHECKED',
          syntheticError: null as string | null
        }
        observations.push(event)
        const descriptor = fs.fstatSync(fd)
        event.owned = descriptor.isFile() && descriptor.dev === version.dev && descriptor.ino === version.ino
        if (!event.owned) throw new Error('unowned regression descriptor')
        fs.closeSync(fd)
        event.realCloseReturned = true
        try {
          fs.fstatSync(fd)
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
    }))
  })

  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
    try {
      // Emergency cleanup only owns descriptors still pointing at this disposable fixture.
      for (const event of observations) {
        if (!event.owned || event.postClose === 'EBADF') continue
        try {
          const current = fs.fstatSync(event.fd)
          if (current.dev === version.dev && current.ino === version.ino) fs.closeSync(event.fd)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error
        }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const reader of ['regular', 'snapshot'] as const) {
    for (const closeFails of [false, true]) {
      for (const changed of [false, true]) {
        it(`${reader}: ${changed ? 'changed file refuses' : 'healthy file'} with ${closeFails ? 'close EIO' : 'successful close'}`, async () => {
          failClose = closeFails
          mutateAfterRead = changed
          const module = await import('./stable-read-sync')
          const result =
            reader === 'regular'
              ? module.readStableRegularFileSync(dir, 'fixture.txt', 1024)
              : module.readStableSnapshotBytesSync(dir, file, 1024)

          expect(observations).toHaveLength(1)
          expect(observations[0]).toMatchObject({
            owned: true,
            realCloseReturned: true,
            postClose: 'EBADF',
            syntheticError: closeFails ? 'EIO' : null
          })
          if (changed)
            expect(fs.readFileSync(file)).toEqual(Buffer.concat([content, Buffer.from('changed after read')]))
          if (closeFails || changed) {
            if (reader === 'regular') expect(result).toEqual({ status: 'refused' })
            else expect(result).toBeNull()
          } else if (reader === 'regular') {
            expect(result).toEqual({ status: 'ok', bytes: content, canonicalRoot: fs.realpathSync.native(dir) })
          } else {
            expect(result).toEqual(content)
          }
        })
      }
    }
  }
})
