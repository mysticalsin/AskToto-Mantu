import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSnapshotFileIo } from './snapshot-io'

let root = ''
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('snapshot file io', () => {
  it('writes sealed bytes under a hashed partition directory and reads them back', async () => {
    root = await mkdtemp(join(tmpdir(), 'metis-g46-'))
    const io = createSnapshotFileIo(root, () => 'partition-owner-a')
    await io.write('snap-1', Buffer.from('sealed-bytes'))
    const dirs = await readdir(root)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]).not.toContain('owner')
    expect((await io.read('snap-1'))?.toString()).toBe('sealed-bytes')
    await io.remove('snap-1')
    expect(await io.read('snap-1')).toBeNull()
  })

  it('refuses names that could leave the directory and a closed partition', async () => {
    root = await mkdtemp(join(tmpdir(), 'metis-g46-'))
    const io = createSnapshotFileIo(root, () => 'p')
    await expect(io.write('../escape', Buffer.from('x'))).rejects.toThrow('invalid snapshot id')
    const closed = createSnapshotFileIo(root, () => null)
    await expect(closed.write('snap-1', Buffer.from('x'))).rejects.toThrow('no memory partition')
  })

  it('purge removes every partition directory', async () => {
    root = await mkdtemp(join(tmpdir(), 'metis-g46-'))
    await createSnapshotFileIo(root, () => 'a').write('s1', Buffer.from('x'))
    await createSnapshotFileIo(root, () => 'b').write('s2', Buffer.from('x'))
    await createSnapshotFileIo(root, () => 'a').purge()
    expect(await readdir(root)).toEqual([])
  })
})
