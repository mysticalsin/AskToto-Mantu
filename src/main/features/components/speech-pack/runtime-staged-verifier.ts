import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeInventoryV1 } from './runtime-provenance'
import { hashPinnedArchive } from './runtime-archive'
import {
  prepareRuntimePhysicalAdmission,
  type RuntimePhysicalAdmission
} from '../../../infra/storage/runtime-owned-files'

const MAX_STAGED_RECORDS = 4096
const MAX_STAGED_PATH_BYTES = 4 * 1024 * 1024

async function readNamesBounded(path: string, maximum: number): Promise<string[]> {
  if (maximum > MAX_STAGED_RECORDS) throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  const directory = await opendir(path, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = await directory.read()
      if (!entry) return names
      if (names.length >= maximum) throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
      names.push(entry.name)
    }
  } finally {
    await directory.close()
  }
}

function sameFileVersion(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.rdev === b.rdev &&
    a.size === b.size &&
    a.blocks === b.blocks &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.birthtimeNs === b.birthtimeNs
  )
}

/** Verify each staged payload and retain its physical version through the final closure pass. */
export async function verifyStagedPayloads(
  stage: string,
  inventories: readonly RuntimeInventoryV1[],
  check: () => Promise<void>,
  options: {
    readonly roots?: readonly {
      readonly path: string
      readonly identity: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
    }[]
    readonly absentPaths?: readonly string[]
  } = {}
): Promise<RuntimePhysicalAdmission> {
  const verifiedVersions = new Map<string, BigIntStats>()
  const verifiedDirectories = new Map<string, { version: BigIntStats; children: readonly string[] }>()
  const artifactsRoot = join(stage, 'artifacts')
  const stageVersion = await lstat(stage, { bigint: true })
  const artifactsVersion = await lstat(artifactsRoot, { bigint: true })
  if (!stageVersion.isDirectory() || !artifactsVersion.isDirectory()) {
    throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  }
  const expectedArtifactDirectories = inventories.map((inventory) => inventory.artifactId).sort()
  let expectedFiles = 0
  let pathBytes = Buffer.byteLength(stage) + Buffer.byteLength(artifactsRoot)
  let totalDirectoryEntries = 0
  for (const inventory of inventories) {
    expectedFiles += inventory.files.length
    pathBytes += Buffer.byteLength(inventory.artifactId)
    for (const file of inventory.files) pathBytes += Buffer.byteLength(file.path)
  }
  if (expectedFiles > MAX_STAGED_RECORDS || pathBytes > MAX_STAGED_PATH_BYTES) {
    throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  }
  const stageNames = (await readNamesBounded(stage, 1)).sort()
  if (stageNames.join('\0') !== 'artifacts') throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  totalDirectoryEntries += stageNames.length
  pathBytes += stageNames.reduce((total, name) => total + Buffer.byteLength(name), 0)
  verifiedDirectories.set(stage, { version: stageVersion, children: stageNames })
  const actualArtifactDirectories = (await readNamesBounded(artifactsRoot, expectedArtifactDirectories.length)).sort()
  if (actualArtifactDirectories.join('\0') !== expectedArtifactDirectories.join('\0')) {
    throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  }
  totalDirectoryEntries += actualArtifactDirectories.length
  pathBytes += actualArtifactDirectories.reduce((total, name) => total + Buffer.byteLength(name), 0)
  if (totalDirectoryEntries > MAX_STAGED_RECORDS || pathBytes > MAX_STAGED_PATH_BYTES) {
    throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  }
  for (const inventory of inventories) {
    const root = join(artifactsRoot, inventory.artifactId)
    const expected = new Map(inventory.files.map((file) => [file.path, file]))
    const directories = new Set<string>()
    for (const path of expected.keys()) {
      const pieces = path.split('/')
      for (let index = 1; index < pieces.length; index++) {
        directories.add(pieces.slice(0, index).join('/'))
        if (directories.size + expected.size > MAX_STAGED_RECORDS) {
          throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
        }
      }
    }
    const found = new Set<string>()
    const folded = new Set<string>()
    const visit = async (directory: string, prefix: string): Promise<void> => {
      const directoryVersion = await lstat(directory, { bigint: true })
      if (!directoryVersion.isDirectory() || directoryVersion.isSymbolicLink()) {
        throw new Error('RUNTIME_STAGED_LINK_REJECTED')
      }
      const names = (await readNamesBounded(directory, MAX_STAGED_RECORDS)).sort()
      totalDirectoryEntries += names.length
      pathBytes += Buffer.byteLength(directory) + names.reduce((total, name) => total + Buffer.byteLength(name), 0)
      if (
        totalDirectoryEntries > MAX_STAGED_RECORDS ||
        verifiedDirectories.size + expectedFiles > MAX_STAGED_RECORDS ||
        pathBytes > MAX_STAGED_PATH_BYTES
      ) {
        throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
      }
      verifiedDirectories.set(directory, { version: directoryVersion, children: names })
      for (const name of names) {
        await check()
        const path = prefix ? `${prefix}/${name}` : name
        const full = join(directory, name)
        const stat = await lstat(full, { bigint: true })
        if (stat.isSymbolicLink()) throw new Error('RUNTIME_STAGED_LINK_REJECTED')
        if (stat.isDirectory()) {
          if (!directories.has(path)) throw new Error('RUNTIME_STAGED_EXTRA_DIRECTORY')
          await visit(full, path)
          const afterDirectory = await lstat(full, { bigint: true })
          if (!sameFileVersion(stat, afterDirectory)) throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
          continue
        }
        const pin = expected.get(path)
        const key = path.toLowerCase()
        if (!stat.isFile() || stat.nlink !== 1n || !pin || folded.has(key)) {
          throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
        }
        folded.add(key)
        found.add(path)
        if (stat.size !== BigInt(pin.bytes) || ((stat.mode & 0o111n) !== 0n) !== pin.executable) {
          throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
        }
        const digest =
          pin.bytes === 0
            ? createHash('sha256').update(Buffer.alloc(0)).digest('hex')
            : await hashPinnedArchive(full, pin.bytes)
        if (digest !== pin.sha256) throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
        const after = await lstat(full, { bigint: true })
        if (!sameFileVersion(stat, after)) throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
        verifiedVersions.set(full, stat)
      }
      const afterDirectory = await lstat(directory, { bigint: true })
      if (!sameFileVersion(directoryVersion, afterDirectory)) throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
    }
    await visit(root, '')
    if (found.size !== expected.size) throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  }
  const currentStage = await lstat(stage, { bigint: true })
  const currentArtifacts = await lstat(artifactsRoot, { bigint: true })
  if (!sameFileVersion(stageVersion, currentStage) || !sameFileVersion(artifactsVersion, currentArtifacts)) {
    throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
  }
  const currentArtifactNames = (await readNamesBounded(artifactsRoot, expectedArtifactDirectories.length)).sort()
  if (currentArtifactNames.join('\0') !== expectedArtifactDirectories.join('\0')) {
    throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
  }
  for (const [directory, snapshot] of verifiedDirectories) {
    await check()
    const [version, names] = await Promise.all([
      lstat(directory, { bigint: true }),
      readNamesBounded(directory, snapshot.children.length)
    ])
    if (!sameFileVersion(snapshot.version, version) || snapshot.children.join('\0') !== names.sort().join('\0')) {
      throw new Error('RUNTIME_STAGED_FILE_CLOSURE_MISMATCH')
    }
  }
  for (const [path, version] of verifiedVersions) {
    await check()
    const current = await lstat(path, { bigint: true })
    if (!sameFileVersion(version, current)) throw new Error('RUNTIME_STAGED_FILE_PIN_MISMATCH')
  }
  // Complete one synchronous ownership and membership pass after all policy/hash awaits.
  // No promise continuation can interleave between this pass and returning to the caller.
  verifiedDirectories.set(artifactsRoot, { version: artifactsVersion, children: expectedArtifactDirectories })
  return prepareRuntimePhysicalAdmission({
    roots: [
      { path: stage, identity: stageVersion },
      { path: artifactsRoot, identity: artifactsVersion },
      ...(options.roots ?? []),
      ...(options.absentPaths ?? []).map((path) => ({ path, mustBeAbsent: true as const }))
    ],
    nodes: [...verifiedVersions].map(([path, version]) => ({ path, version })),
    directories: [...verifiedDirectories].map(([path, snapshot]) => ({
      path,
      version: snapshot.version,
      children: snapshot.children
    }))
  })
}
