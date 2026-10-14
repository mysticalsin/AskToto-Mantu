import { randomUUID } from 'node:crypto'
import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isSafeEntryName } from './archive'
import { pathExists as exists } from './download'
import type { SpeechPackComponent } from './manifest'
import {
  capturePhysicalPathVersion,
  physicalOwnerMatches,
  physicalPathVersionMatches,
  samePhysicalPathVersion,
  type PhysicalPathVersion
} from './physical-ownership'

export interface TreeEntry {
  relative: string
  kind: 'directory' | 'file'
  version: PhysicalPathVersion
}

export function createSpeechPackOwnedTreeCleanup() {
  const treePaths = new WeakMap<
    SpeechPackComponent,
    { files: Set<string>; directories: Set<string>; stagingFiles: Set<string> }
  >()
  const pathsFor = (c: SpeechPackComponent) => {
    const known = treePaths.get(c)
    if (known) return known
    const files = new Set(c.files.map((file) => file.path))
    const directories = new Set<string>()
    const stagingFiles = new Set<string>()
    for (const file of c.files) {
      stagingFiles.add(file.path)
      stagingFiles.add(`${file.path}.partial`)
      stagingFiles.add(`${file.path}.partial.json`)
      const parts = file.path.split('/')
      for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'))
    }
    const paths = { files, directories, stagingFiles }
    treePaths.set(c, paths)
    return paths
  }
  const inspectTree = async (
    path: string,
    maxEntries: number,
    allowed: (relative: string, kind: 'directory' | 'file') => boolean
  ): Promise<TreeEntry[] | null> => {
    const entries: TreeEntry[] = []
    const visit = async (current: string, relative: string): Promise<boolean> => {
      const directory = await capturePhysicalPathVersion(current, 'directory')
      if (!directory || (relative !== '' && !allowed(relative, 'directory'))) {
        const file = await capturePhysicalPathVersion(current, 'file')
        if (!file || !allowed(relative, 'file')) return false
        entries.push({ relative, kind: 'file', version: file })
        return entries.length <= maxEntries
      }
      entries.push({ relative, kind: 'directory', version: directory })
      if (entries.length > maxEntries) return false
      let names: string[]
      try {
        names = await readdir(current)
      } catch {
        return false
      }
      for (const name of names) {
        if (!isSafeEntryName(name) || !(await visit(join(current, name), relative ? `${relative}/${name}` : name)))
          return false
      }
      return true
    }
    return (await visit(path, '')) ? entries : null
  }

  const sameTree = (before: TreeEntry[], after: TreeEntry[]): boolean => {
    if (before.length !== after.length) return false
    const right = new Map(after.map((entry) => [entry.relative, entry]))
    return before.every((entry) => {
      const current = right.get(entry.relative)
      if (!current || current.kind !== entry.kind) return false
      return entry.relative === ''
        ? entry.version.dev === current.version.dev && entry.version.ino === current.version.ino
        : samePhysicalPathVersion(entry.version, current.version)
    })
  }

  const sameExpectedTree = (expected: TreeEntry[], current: TreeEntry[], movedFiles: Set<string>): boolean => {
    const actual = new Map(current.map((entry) => [entry.relative, entry]))
    const expectedPaths = new Map(
      expected.map((entry) => [entry.relative ? `extract/${entry.relative}` : 'extract', entry])
    )
    for (const entry of expected) {
      if (entry.kind === 'file' && movedFiles.has(entry.relative)) continue
      const path = entry.relative ? `extract/${entry.relative}` : 'extract'
      const found = actual.get(path)
      if (!found || found.kind !== entry.kind) return false
      if (entry.kind === 'directory') {
        if (found.version.dev !== entry.version.dev || found.version.ino !== entry.version.ino) return false
      } else if (!samePhysicalPathVersion(entry.version, found.version)) return false
    }
    for (const path of actual.keys()) {
      if (!path.startsWith('extract/')) continue
      const entry = expectedPaths.get(path)
      if (!entry || (entry.kind === 'file' && movedFiles.has(entry.relative))) return false
    }
    return true
  }

  const removeInspectedTree = async (
    path: string,
    expected: PhysicalPathVersion,
    maxEntries: number,
    allowed: (relative: string, kind: 'directory' | 'file') => boolean,
    expectedExtract?: TreeEntry[],
    movedExtractFiles = new Set<string>()
  ): Promise<boolean> => {
    if (!(await physicalPathVersionMatches(path, expected))) return false
    const before = await inspectTree(path, maxEntries, allowed)
    if (!before) return false
    if (expectedExtract && !sameExpectedTree(expectedExtract, before, movedExtractFiles)) return false
    if (!(await physicalPathVersionMatches(path, expected))) return false
    const quarantined = join(dirname(path), `.${basename(path)}.owned-delete-${randomUUID()}`)
    if (await exists(quarantined)) return false
    await rename(path, quarantined)
    const moved = await capturePhysicalPathVersion(quarantined, 'directory')
    if (!moved || moved.dev !== expected.dev || moved.ino !== expected.ino) {
      if (!(await exists(path)) && (await exists(quarantined))) await rename(quarantined, path)
      return false
    }
    const after = await inspectTree(quarantined, maxEntries, allowed)
    if (
      !after ||
      !sameTree(before, after) ||
      (expectedExtract && !sameExpectedTree(expectedExtract, after, movedExtractFiles))
    ) {
      if (!(await exists(path)) && (await exists(quarantined))) await rename(quarantined, path)
      return false
    }
    const prefix = (entry: TreeEntry): string =>
      entry.relative ? join(quarantined, ...entry.relative.split('/')) : quarantined
    const files = after.filter((entry) => entry.kind === 'file').sort((a, b) => b.relative.length - a.relative.length)
    for (const entry of files) {
      const file = prefix(entry)
      if (!(await physicalPathVersionMatches(file, entry.version))) return false
      const fileQuarantine = `${file}.owned-delete-${randomUUID()}`
      await rename(file, fileQuarantine)
      const movedFile = await capturePhysicalPathVersion(fileQuarantine, 'file')
      if (
        !movedFile ||
        movedFile.dev !== entry.version.dev ||
        movedFile.ino !== entry.version.ino ||
        movedFile.mode !== entry.version.mode ||
        movedFile.nlink !== entry.version.nlink ||
        movedFile.size !== entry.version.size ||
        movedFile.mtimeNs !== entry.version.mtimeNs
      ) {
        if (!(await exists(file)) && (await exists(fileQuarantine))) await rename(fileQuarantine, file)
        return false
      }
      await unlink(fileQuarantine)
    }
    const directories = after
      .filter((entry) => entry.kind === 'directory' && entry.relative !== '')
      .sort((a, b) => b.relative.split('/').length - a.relative.split('/').length)
    for (const entry of directories) {
      const directory = prefix(entry)
      if (!(await physicalOwnerMatches(directory, entry.version, 'directory'))) return false
      await rmdir(directory)
    }
    await rmdir(quarantined)
    return true
  }

  const packTreeAllowed = (c: SpeechPackComponent, relative: string, kind: 'directory' | 'file'): boolean => {
    const { files, directories } = pathsFor(c)
    return kind === 'file' ? files.has(relative) : directories.has(relative)
  }

  const stagingTreeAllowed = (c: SpeechPackComponent, relative: string, kind: 'directory' | 'file'): boolean => {
    if (relative === c.version) return kind === 'directory'
    if (relative === 'work') return kind === 'directory'
    if (relative.startsWith(`${c.version}/`)) {
      const file = relative.slice(c.version.length + 1)
      return kind === 'directory' ? packTreeAllowed(c, file, 'directory') : pathsFor(c).stagingFiles.has(file)
    }
    if (relative.startsWith('work/')) {
      const child = relative.slice(5)
      if (child === 'extract') return kind === 'directory'
      if (child.startsWith('extract/')) return false
      return (
        kind === 'file' &&
        ['archive.download', 'archive.download.partial', 'archive.download.partial.json'].includes(child)
      )
    }
    return false
  }

  const treeEntryLimit = (c: SpeechPackComponent): number =>
    32 + c.files.reduce((total, file) => total + file.path.split('/').length * 3, 0)

  return {
    removeInspectedTree,
    packTreeAllowed,
    stagingTreeAllowed,
    treeEntryLimit,
    sameExpectedTree
  }
}
