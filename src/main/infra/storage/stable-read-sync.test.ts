import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { canonicalSourceRootId } from '../../brain/inputs'
import { canonicalPathSync, readStableRegularFileSync } from './stable-read-sync'

const LINK_DIR_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

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
