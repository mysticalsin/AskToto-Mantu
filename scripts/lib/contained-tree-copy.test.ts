import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyContainedTree } from './contained-tree-copy.mjs'

const linkKind = process.platform === 'win32' ? 'junction' : 'dir'

describe('contained staged-resource copying', () => {
  it('materializes an internal directory link into regular packaged files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-contained-copy-'))
    const source = join(root, 'source')
    const destination = join(root, 'destination')
    try {
      await mkdir(join(source, 'lib'), { recursive: true })
      await writeFile(join(source, 'lib', 'target.js'), 'verified target')
      await symlink(join(source, 'lib'), join(source, 'linked-lib'), linkKind)
      await copyContainedTree(source, destination, { allowSymlinkTargetsWithin: source })
      expect(await readFile(join(destination, 'linked-lib', 'target.js'), 'utf8')).toBe('verified target')
      expect((await lstat(join(destination, 'linked-lib'))).isSymbolicLink()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an external link, a dangling link and a linked source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-contained-copy-'))
    const source = join(root, 'source')
    const outside = join(root, 'outside')
    try {
      await mkdir(source)
      await mkdir(outside)
      await writeFile(join(outside, 'outside.txt'), 'outside')
      await symlink(outside, join(source, 'external'), linkKind)
      await expect(
        copyContainedTree(source, join(root, 'external-output'), { allowSymlinkTargetsWithin: source })
      ).rejects.toThrow(/escapes/)

      await rm(join(source, 'external'), { recursive: true, force: true })
      await mkdir(join(source, 'dangling-target'))
      await symlink(join(source, 'dangling-target'), join(source, 'dangling'), linkKind)
      await rm(join(source, 'dangling-target'), { recursive: true, force: true })
      await expect(
        copyContainedTree(source, join(root, 'dangling-output'), { allowSymlinkTargetsWithin: source })
      ).rejects.toThrow(/dangling or invalid/)

      await rm(join(source, 'dangling'), { recursive: true, force: true })
      const linkedRoot = join(root, 'linked-root')
      await symlink(outside, linkedRoot, linkKind)
      await expect(
        copyContainedTree(linkedRoot, join(root, 'root-output'), { allowSymlinkTargetsWithin: linkedRoot })
      ).rejects.toThrow(/source root must be a real directory/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
