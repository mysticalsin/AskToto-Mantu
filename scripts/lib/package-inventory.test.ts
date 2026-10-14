import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inventoryCoreFiles, packageInventoryIdentity, validatePackageInventory } from './package-inventory.mjs'
import type { PackageInventoryV1 } from '../../src/shared/package-profile'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

function inventory(): PackageInventoryV1 {
  const value = {
    schema: 1 as const,
    profile: 'lean' as const,
    platform: 'darwin' as const,
    arch: 'arm64' as const,
    appVersion: '1.9.7',
    electronVersion: '43.6.0',
    sourceCommit: 'a'.repeat(40),
    coreFiles: [
      { path: 'intelligence/index.html', bytes: 8, sha256: sha('index\n\n') },
      { path: 'speech-pack-profile.json', bytes: 30, sha256: sha('{"schema":1,"profile":"lean"}\n') }
    ],
    identity: ''
  }
  value.identity = packageInventoryIdentity(value)
  return value
}

describe('lean package inventory contract', () => {
  it('uses a canonical ordered payload identity that validates for one target', () => {
    expect(validatePackageInventory(inventory()).arch).toBe('arm64')
  })

  it('rejects changed core bytes, unsorted entries, duplicate paths, and non-target universal lean builds', () => {
    const changed = inventory()
    changed.coreFiles[0].bytes += 1
    expect(() => validatePackageInventory(changed)).toThrow(/identity/)

    const unsorted = inventory()
    unsorted.coreFiles.reverse()
    unsorted.identity = packageInventoryIdentity(unsorted)
    expect(() => validatePackageInventory(unsorted)).toThrow(/sorted/)

    const duplicate = inventory()
    duplicate.coreFiles[1].path = duplicate.coreFiles[0].path
    duplicate.identity = packageInventoryIdentity(duplicate)
    expect(() => validatePackageInventory(duplicate)).toThrow(/unique and sorted/)

    const universal = inventory()
    universal.arch = 'universal'
    universal.identity = packageInventoryIdentity(universal)
    expect(() => validatePackageInventory(universal)).toThrow(/one architecture/)
  })

  it('rejects unexpected schema fields and Windows ARM64', () => {
    const extended = { ...inventory(), guessedSizeBytes: 1 }
    extended.identity = packageInventoryIdentity(extended)
    expect(() => validatePackageInventory(extended)).toThrow(/unexpected fields/)

    const windowsArm = inventory()
    windowsArm.platform = 'win32'
    windowsArm.arch = 'arm64'
    windowsArm.identity = packageInventoryIdentity(windowsArm)
    expect(() => validatePackageInventory(windowsArm)).toThrow(/Windows inventory/)
  })

  it('rejects package inventory paths that escape the package resource root', () => {
    const escaped = inventory()
    escaped.coreFiles[0].path = '../outside.json'
    escaped.identity = packageInventoryIdentity(escaped)
    expect(() => validatePackageInventory(escaped)).toThrow(/path is invalid/)
  })

  it('hashes every staged regular file in canonical path order and excludes only the inventory itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'metis-package-inventory-'))
    try {
      await mkdir(join(root, 'skills'), { recursive: true })
      await writeFile(join(root, 'skills', 'z.md'), 'z')
      await writeFile(join(root, 'a.json'), '{}')
      await writeFile(join(root, 'package-inventory.json'), '{}')
      const files = await inventoryCoreFiles(root)
      expect(files.map(({ path }) => path)).toEqual(['a.json', 'skills/z.md'])
      expect(files.map(({ bytes }) => bytes)).toEqual([2, 1])
      expect(files.map(({ sha256 }) => sha256)).toEqual([sha('{}'), sha('z')])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
