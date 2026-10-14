import { createHash } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { RuntimeInventoryV1 } from './runtime-provenance'
import { hashPinnedArchive } from './runtime-archive'
import { sameRuntimeFileVersion } from '../../../infra/storage/runtime-owned-files'

const MAX_PHYSICAL_RECORDS = 4096
const MAX_PHYSICAL_PATH_BYTES = 4 * 1024 * 1024

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function assertFileRoot(root: string, relPath: string): Promise<string> {
  let current = root
  const parts = relPath.split('/')
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index])
    const item = await lstat(current)
    if (
      item.isSymbolicLink() ||
      (index === parts.length - 1 ? !item.isFile() || item.nlink !== 1 : !item.isDirectory())
    ) {
      throw new Error('RUNTIME_GENERATION_FILE_SHAPE_INVALID')
    }
  }
  const canonical = await realpath(current)
  const expected = resolve(root, ...parts)
  const rel = relative(root, canonical)
  if (canonical !== expected || !rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('RUNTIME_GENERATION_FILE_ESCAPE')
  }
  return canonical
}

export async function assertEvidenceClosure(evidenceRoot: string): Promise<void> {
  const expected = ['bundle.json', 'inventory.json', 'payload.tar.gz']
  const actual = (await readNamesBounded(evidenceRoot, expected.length)).sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error('RUNTIME_EVIDENCE_CLOSURE_MISMATCH')
  }
  for (const name of expected) {
    const stat = await lstat(join(evidenceRoot, name), { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw new Error('RUNTIME_EVIDENCE_FILE_INVALID')
    }
  }
}

export async function readNamesBounded(path: string, maximum: number): Promise<string[]> {
  if (maximum > MAX_PHYSICAL_RECORDS) throw new Error('RUNTIME_PHYSICAL_LIMIT')
  const directory = await opendir(path, { bufferSize: 1 })
  const names: string[] = []
  try {
    for (;;) {
      const entry = await directory.read()
      if (!entry) return names
      if (names.length >= maximum) throw new Error('RUNTIME_PHYSICAL_CLOSURE_CHANGED')
      names.push(entry.name)
    }
  } finally {
    await directory.close()
  }
}

export async function assertExactDirectories(root: string, names: readonly string[]): Promise<void> {
  const actual = (await readNamesBounded(root, names.length)).sort()
  const expected = [...names].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error('RUNTIME_GENERATION_DIRECTORY_CLOSURE_MISMATCH')
  }
}

export async function assertInstalledClosure(
  root: string,
  inventory: RuntimeInventoryV1,
  signal?: AbortSignal
): Promise<{
  files: Map<string, BigIntStats>
  directories: Map<string, { version: BigIntStats; children: readonly string[] }>
}> {
  const expected = new Map(inventory.files.map((file) => [file.path, file]))
  if (expected.size > MAX_PHYSICAL_RECORDS) throw new Error('RUNTIME_PHYSICAL_LIMIT')
  const pathBytes = [...expected.keys()].reduce((total, path) => total + Buffer.byteLength(path), 0)
  if (pathBytes > MAX_PHYSICAL_PATH_BYTES) throw new Error('RUNTIME_PHYSICAL_LIMIT')
  const expectedDirectories = new Set<string>()
  for (const path of expected.keys()) {
    const parts = path.split('/')
    for (let depth = 1; depth < parts.length; depth++) {
      expectedDirectories.add(parts.slice(0, depth).join('/'))
      if (expectedDirectories.size + expected.size > MAX_PHYSICAL_RECORDS) throw new Error('RUNTIME_PHYSICAL_LIMIT')
    }
  }
  const found = new Map<string, string>()
  const directories = new Map<string, { version: BigIntStats; children: readonly string[] }>()
  const folded = new Set<string>()
  let totalEntries = 0
  let totalPathBytes = pathBytes
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const directoryVersion = await lstat(dir, { bigint: true })
    if (!directoryVersion.isDirectory() || directoryVersion.isSymbolicLink()) {
      throw new Error('RUNTIME_GENERATION_LINK_REJECTED')
    }
    const names = (await readNamesBounded(dir, MAX_PHYSICAL_RECORDS)).sort()
    totalEntries += names.length
    totalPathBytes += Buffer.byteLength(dir) + names.reduce((total, name) => total + Buffer.byteLength(name), 0)
    if (totalEntries > MAX_PHYSICAL_RECORDS || totalPathBytes > MAX_PHYSICAL_PATH_BYTES) {
      throw new Error('RUNTIME_PHYSICAL_LIMIT')
    }
    directories.set(dir, { version: directoryVersion, children: names })
    for (const name of names) {
      if (signal?.aborted) throw signal.reason ?? new Error('RUNTIME_VERIFY_CANCELLED')
      const rel = prefix ? `${prefix}/${name}` : name
      const path = join(dir, name)
      const stat = await lstat(path, { bigint: true })
      if (stat.isSymbolicLink()) throw new Error('RUNTIME_GENERATION_LINK_REJECTED')
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(rel)) throw new Error('RUNTIME_GENERATION_EXTRA_DIRECTORY')
        await visit(path, rel)
        if (!sameRuntimeFileVersion(stat, await lstat(path, { bigint: true }))) {
          throw new Error('RUNTIME_GENERATION_FILE_CHANGED')
        }
      } else if (stat.isFile() && stat.nlink === 1n) {
        const key = rel.toLowerCase()
        if (!expected.has(rel) || folded.has(key)) throw new Error('RUNTIME_GENERATION_EXTRA_FILE')
        folded.add(key)
        found.set(rel, path)
      } else throw new Error('RUNTIME_GENERATION_SPECIAL_FILE')
    }
    if (!sameRuntimeFileVersion(directoryVersion, await lstat(dir, { bigint: true }))) {
      throw new Error('RUNTIME_GENERATION_FILE_CHANGED')
    }
  }
  await visit(root, '')
  if (
    found.size !== expected.size ||
    found.size + directories.size > MAX_PHYSICAL_RECORDS ||
    totalPathBytes > MAX_PHYSICAL_PATH_BYTES
  )
    throw new Error('RUNTIME_GENERATION_FILE_CLOSURE_MISMATCH')
  const versions = new Map<string, BigIntStats>()
  for (const [rel, pin] of expected) {
    if (signal?.aborted) throw signal.reason ?? new Error('RUNTIME_VERIFY_CANCELLED')
    const path = await assertFileRoot(root, rel)
    const fileStat = await lstat(path, { bigint: true })
    if (
      path !== found.get(rel) ||
      fileStat.size !== BigInt(pin.bytes) ||
      ((fileStat.mode & 0o111n) !== 0n) !== pin.executable
    ) {
      throw new Error('RUNTIME_GENERATION_FILE_PIN_MISMATCH')
    }
    if (pin.bytes > 0 && (await hashPinnedArchive(path, pin.bytes)) !== pin.sha256) {
      throw new Error('RUNTIME_GENERATION_FILE_PIN_MISMATCH')
    }
    if (pin.bytes === 0 && sha256(Buffer.alloc(0)) !== pin.sha256) {
      throw new Error('RUNTIME_GENERATION_FILE_PIN_MISMATCH')
    }
    const afterHash = await lstat(path, { bigint: true })
    if (
      afterHash.dev !== fileStat.dev ||
      afterHash.ino !== fileStat.ino ||
      afterHash.mode !== fileStat.mode ||
      afterHash.nlink !== fileStat.nlink ||
      afterHash.uid !== fileStat.uid ||
      afterHash.gid !== fileStat.gid ||
      afterHash.rdev !== fileStat.rdev ||
      afterHash.size !== fileStat.size ||
      afterHash.blocks !== fileStat.blocks ||
      afterHash.mtimeNs !== fileStat.mtimeNs ||
      afterHash.ctimeNs !== fileStat.ctimeNs ||
      afterHash.birthtimeNs !== fileStat.birthtimeNs
    ) {
      throw new Error('RUNTIME_GENERATION_FILE_CHANGED')
    }
    versions.set(path, afterHash)
  }
  return { files: versions, directories }
}
