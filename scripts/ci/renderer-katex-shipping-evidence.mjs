#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { extractFile, getRawHeader, uncache } from '@electron/asar'
import {
  compareInventories,
  findEmbeddedOldKaTeX,
  inventoryTree,
  validateKaTeXArchive,
  validateGraph
} from './renderer-katex-build-evidence.mjs'
import { packageInventoryIdentity, validatePackageInventory } from '../lib/package-inventory.mjs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_ENTRIES = 250_000
const MAX_ASAR_ENTRY_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ASAR_HEADER_BYTES = 64 * 1024 * 1024
const MAX_DELIVERED_BYTES = 16 * 1024 * 1024 * 1024
const MAX_ASAR_DEPTH = 256
const MAX_LOOSE_DEPTH = 256
const OLD_MARKERS = ['version = "0.16.47"', 'katex@0.16.47', 'katex-HNBAO5SE', 'katex-CZ4GXH2S']

function fail(code) {
  throw new Error(`renderer-katex-shipping-evidence:${code}`)
}
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
function admissionBudget(limit = MAX_DELIVERED_BYTES) {
  let entries = 0
  let bytes = 0
  const physical = new Map()
  return {
    admit(size = 0, physicalPath = null) {
      entries += 1
      if (physicalPath !== null) {
        const prior = physical.get(physicalPath)
        if (prior !== undefined && prior !== size) fail('DELIVERED_PHYSICAL_SIZE_CHANGED')
        if (prior === undefined) {
          physical.set(physicalPath, size)
          bytes += size
        }
      } else bytes += size
      if (entries > MAX_ENTRIES) fail('DELIVERED_ENTRY_COUNT_LIMIT')
      if (!Number.isSafeInteger(bytes) || bytes > limit) fail('DELIVERED_TOTAL_BYTE_LIMIT')
    }
  }
}
function parseArgs(argv) {
  const args = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--') || !argv[index + 1] || args.has(token.slice(2))) fail('ARGUMENTS')
    args.set(token.slice(2), argv[++index])
  }
  for (const key of ['resources', 'build-evidence', 'candidate-receipt', 'katex-tarball', 'profile', 'arch', 'out'])
    if (!args.has(key)) fail('ARGUMENTS')
  if (!['full', 'lean'].includes(args.get('profile'))) fail('PROFILE')
  if (!['win-x64', 'mac-universal', 'mac-arm64', 'mac-x64'].includes(args.get('arch'))) fail('ARCH')
  return args
}
function shaFile(path) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`NOT_REGULAR_FILE:${path}`)
  if (stat.size > MAX_ASAR_ENTRY_BYTES) fail(`FILE_SIZE_LIMIT:${path}`)
  return new Promise((resolveHash, reject) => {
    const digest = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => digest.update(chunk))
      .on('end', () => resolveHash({ bytes: stat.size, sha256: digest.digest('hex') }))
      .on('error', reject)
  })
}
function shaAsarRange(archive, entry, headerSize) {
  if (typeof entry.offset !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(entry.offset))
    fail(`ASAR_RANGE_SCHEMA:${entry.path}`)
  const offset = Number.parseInt(entry.offset, 10)
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(entry.size) || entry.size < 0)
    fail(`ASAR_RANGE_SCHEMA:${entry.path}`)
  const start = 8 + headerSize + offset
  const end = start + entry.size - 1
  const archiveSize = lstatSync(archive).size
  if (!Number.isSafeInteger(start) || start < 0 || start + entry.size > archiveSize)
    fail(`ASAR_RANGE_BOUNDS:${entry.path}`)
  return new Promise((resolveHash, reject) => {
    const digest = createHash('sha256')
    const stream = entry.size === 0 ? null : createReadStream(archive, { start, end })
    if (!stream) return resolveHash({ bytes: 0, sha256: digest.digest('hex') })
    stream.on('data', (chunk) => digest.update(chunk))
    stream.on('end', () => resolveHash({ bytes: entry.size, sha256: digest.digest('hex') }))
    stream.on('error', reject)
  })
}
function normalizeAsarPath(value) {
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/u.test(value)) fail('ASAR_ABSOLUTE_PATH')
  const path = value.split('\\').join('/')
  if (!path || path.split('/').some((part) => !part || part === '.' || part === '..')) fail('ASAR_UNSAFE_PATH')
  return path
}
function nativeAsarMember(logicalPath) {
  if (typeof logicalPath !== 'string' || normalizeAsarPath(logicalPath) !== logicalPath) fail('ASAR_UNSAFE_PATH')
  return logicalPath.split('/').join(sep)
}
function isCodeContainerPrefix(bytes) {
  return (
    bytes.subarray(0, 4).equals(Buffer.from('PK\x03\x04')) ||
    bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    (bytes.length >= 8 && bytes.readUInt32LE(0) === 4 && bytes.readUInt32LE(4) >= 8)
  )
}
function isStructuredNative(prefix, size) {
  if (prefix.subarray(0, 2).toString('ascii') === 'MZ') {
    const peOffset = prefix.readUInt32LE(0x3c)
    if (
      peOffset < 0x40 ||
      peOffset + 24 > prefix.length ||
      prefix.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
    )
      return false
    const machine = prefix.readUInt16LE(peOffset + 4)
    const sections = prefix.readUInt16LE(peOffset + 6)
    const optionalSize = prefix.readUInt16LE(peOffset + 20)
    const table = peOffset + 24 + optionalSize
    if (
      ![0x14c, 0x8664, 0xaa64].includes(machine) ||
      sections < 1 ||
      sections > 96 ||
      optionalSize < 0x60 ||
      table + sections * 40 > prefix.length ||
      ![0x10b, 0x20b].includes(prefix.readUInt16LE(peOffset + 24))
    )
      return false
    let dataSections = 0
    for (let index = 0; index < sections; index += 1) {
      const section = table + index * 40
      const rawSize = prefix.readUInt32LE(section + 16)
      const rawOffset = prefix.readUInt32LE(section + 20)
      if (rawSize) {
        if (rawOffset < table + sections * 40 || rawOffset + rawSize > size) return false
        dataSections += 1
      }
    }
    return dataSections > 0
  }
  if (prefix.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (prefix[5] !== 1 || ![1, 2].includes(prefix[4])) return false
    const is64 = prefix[4] === 2
    const headerSize = is64 ? 64 : 52
    const type = prefix.readUInt16LE(16)
    const machine = prefix.readUInt16LE(18)
    const phOffset = is64 ? Number(prefix.readBigUInt64LE(32)) : prefix.readUInt32LE(28)
    const phEntrySize = prefix.readUInt16LE(is64 ? 54 : 42)
    const phCount = prefix.readUInt16LE(is64 ? 56 : 44)
    return (
      [2, 3].includes(type) &&
      machine > 0 &&
      prefix.readUInt16LE(is64 ? 52 : 40) === headerSize &&
      phCount > 0 &&
      phEntrySize >= (is64 ? 56 : 32) &&
      Number.isSafeInteger(phOffset) &&
      phOffset >= headerSize &&
      phOffset + phEntrySize * phCount <= size
    )
  }
  const magic = prefix.readUInt32BE(0)
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const count = prefix.readUInt32BE(4)
    const wide = magic === 0xcafebabf
    const stride = wide ? 32 : 20
    if (count < 1 || count > 32 || 8 + count * stride > prefix.length) return false
    for (let index = 0; index < count; index += 1) {
      const at = 8 + index * stride
      const offset = wide ? Number(prefix.readBigUInt64BE(at + 8)) : prefix.readUInt32BE(at + 8)
      const length = wide ? Number(prefix.readBigUInt64BE(at + 16)) : prefix.readUInt32BE(at + 12)
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        length < 32 ||
        offset < 8 + count * stride ||
        offset + length > size
      )
        return false
    }
    return true
  }
  if ([0xfeedfacf, 0xcffaedfe].includes(prefix.readUInt32LE(0))) {
    const swapped = prefix.readUInt32LE(0) === 0xcffaedfe
    const read32 = (offset) => (swapped ? prefix.readUInt32BE(offset) : prefix.readUInt32LE(offset))
    const count = read32(16)
    const commands = read32(20)
    return (
      count > 0 &&
      count <= 4096 &&
      commands >= count * 8 &&
      commands <= size - 32 &&
      read32(4) !== 0 &&
      read32(32 + 4) >= 8 &&
      read32(32 + 4) <= commands
    )
  }
  return false
}
async function inventoryLoose(root, prefix, containmentRoot = root, budget = admissionBudget(), deferHash = false) {
  const resolveLink = (path, label) => {
    try {
      return realpathSync(path)
    } catch (error) {
      if (error?.code === 'ELOOP') fail(`LOOSE_SYMLINK_CYCLE:${label}`)
      if (error?.code === 'ENOENT') fail(`LOOSE_LINK_TARGET_MISSING:${label}`)
      throw error
    }
  }
  let rootStat
  try {
    rootStat = lstatSync(root)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    throw error
  }
  const realContainmentRoot = resolveLink(containmentRoot, prefix)
  if (rootStat.isSymbolicLink()) {
    const physicalPath = resolveLink(root, prefix)
    const contained = relative(realContainmentRoot, physicalPath).replaceAll('\\', '/')
    const targetStat = lstatSync(physicalPath)
    if (!contained || contained === '..' || contained.startsWith('../') || isAbsolute(contained))
      fail(`LOOSE_ROOT_LINK:${prefix}`)
    if (targetStat.isDirectory()) {
      budget.admit()
      return [
        { path: prefix, type: 'link-directory', target: contained },
        ...(await inventoryLoose(physicalPath, prefix, containmentRoot, budget, deferHash))
      ]
    }
    if (!targetStat.isFile()) fail(`LOOSE_ROOT_LINK:${prefix}`)
    budget.admit(targetStat.size, physicalPath)
    return [
      {
        path: prefix,
        type: 'link',
        physicalPath,
        target: contained,
        ...(deferHash ? { bytes: targetStat.size } : await shaFile(physicalPath))
      }
    ]
  }
  if (!rootStat.isDirectory()) fail(`LOOSE_ROOT_TYPE:${prefix}`)
  const paths = []
  let admittedBytes = 0
  const activeDirectories = new Set()
  function collect(directory, relativeRoot, depth = 0) {
    if (depth > MAX_LOOSE_DEPTH) fail('LOOSE_DEPTH_LIMIT')
    const realDirectory = resolveLink(directory, relativeRoot)
    if (activeDirectories.has(realDirectory)) fail(`LOOSE_SYMLINK_CYCLE:${relativeRoot}`)
    activeDirectories.add(realDirectory)
    for (const entry of readdirSync(realDirectory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const path = join(realDirectory, entry.name)
      const relativePath = `${relativeRoot}/${entry.name}`.replaceAll('\\', '/')
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) {
        const physicalPath = resolveLink(path, relativePath)
        const contained = relative(realContainmentRoot, physicalPath).replaceAll('\\', '/')
        if (!contained || contained === '..' || contained.startsWith('../') || isAbsolute(contained))
          fail(`LOOSE_EXTERNAL_SYMLINK:${relativePath}`)
        const targetStat = lstatSync(physicalPath)
        if (targetStat.isDirectory()) {
          budget.admit()
          paths.push({ path: relativePath, type: 'link-directory', absolute: physicalPath, target: contained })
          collect(physicalPath, relativePath, depth + 1)
        } else if (targetStat.isFile()) {
          budget.admit(targetStat.size, physicalPath)
          admittedBytes += targetStat.size
          paths.push({ path: relativePath, type: 'link', absolute: physicalPath, target: contained })
        } else fail(`LOOSE_SYMLINK_TYPE:${relativePath}`)
      } else if (stat.isDirectory()) {
        budget.admit()
        paths.push({ path: relativePath, type: 'directory', absolute: path })
        collect(path, relativePath, depth + 1)
      } else if (stat.isFile()) {
        budget.admit(stat.size, path)
        admittedBytes += stat.size
        paths.push({ path: relativePath, type: 'file', absolute: path })
      } else fail(`LOOSE_SPECIAL_ENTRY:${relativePath}`)
      if (paths.length > MAX_ENTRIES) fail('LOOSE_ENTRY_COUNT_LIMIT')
      if (!Number.isSafeInteger(admittedBytes) || admittedBytes > MAX_DELIVERED_BYTES) fail('LOOSE_TOTAL_BYTE_LIMIT')
    }
    activeDirectories.delete(realDirectory)
  }
  collect(root, prefix)
  const inventory = []
  for (const { path, type, absolute, target } of paths)
    inventory.push(
      type === 'directory' || type === 'link-directory'
        ? { path, type, ...(target ? { target } : {}) }
        : {
            path,
            type,
            physicalPath: absolute,
            ...(target ? { target } : {}),
            ...(deferHash ? { bytes: lstatSync(absolute).size } : await shaFile(absolute))
          }
    )
  return inventory
}
async function asarInventory(archive, unpackedRoot, budget = admissionBudget(), deferHash = false) {
  uncache(archive)
  const archiveFd = openSync(archive, 'r')
  let archiveSize
  try {
    const stat = fstatSync(archiveFd)
    archiveSize = stat.size
    const prefix = Buffer.alloc(8)
    if (stat.size < prefix.length || readSync(archiveFd, prefix, 0, prefix.length, 0) !== prefix.length)
      fail('ASAR_HEADER_PREFIX')
    if (prefix.readUInt32LE(0) !== 4) fail('ASAR_SIZE_PICKLE_SCHEMA')
    const headerSize = prefix.readUInt32LE(4)
    const headerEnd = 8 + headerSize
    if (headerSize < 8 || headerSize > MAX_ASAR_HEADER_BYTES || headerEnd >= stat.size) fail('ASAR_HEADER_SIZE_LIMIT')
  } finally {
    closeSync(archiveFd)
  }
  const { header, headerSize } = getRawHeader(archive)
  if (!header?.files || typeof header.files !== 'object') fail('ASAR_HEADER_SCHEMA')
  const unique = new Set()
  const entries = []
  const packedRanges = []
  let realUnpackedRoot
  let totalBytes = 0
  async function collect(files, parent = '') {
    if (parent.split('/').filter(Boolean).length > MAX_ASAR_DEPTH) fail('ASAR_DEPTH_LIMIT')
    if (!files || typeof files !== 'object' || Array.isArray(files)) fail('ASAR_DIRECTORY_SCHEMA')
    for (const [name, info] of Object.entries(files || {}).sort(([left], [right]) => left.localeCompare(right))) {
      if (!info || typeof info !== 'object' || Array.isArray(info)) fail('ASAR_ENTRY_SCHEMA')
      if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) fail('ASAR_ENTRY_NAME')
      const path = normalizeAsarPath(parent ? `${parent}/${name}` : name)
      const canonical = path.normalize('NFC').toLocaleLowerCase('en-US')
      if (unique.has(canonical)) fail('ASAR_DUPLICATE_PATH')
      unique.add(canonical)
      if (entries.length >= MAX_ENTRIES) fail('ASAR_ENTRY_COUNT')
      if (info.files !== undefined) {
        budget.admit()
        if (
          typeof info.files !== 'object' ||
          info.files === null ||
          Array.isArray(info.files) ||
          info.link !== undefined ||
          info.size !== undefined ||
          info.offset !== undefined
        )
          fail(`ASAR_DIRECTORY_TYPE:${path}`)
        entries.push({ path, type: 'directory', bytes: 0, sha256: null })
        await collect(info.files, path)
        continue
      }
      if (typeof info.link === 'string') {
        budget.admit()
        if (
          info.size !== undefined ||
          info.offset !== undefined ||
          (info.unpacked !== undefined && typeof info.unpacked !== 'boolean')
        )
          fail(`ASAR_LINK_TYPE:${path}`)
        const link = info.link
        if (link.startsWith('/') || link.startsWith('\\') || /^[A-Za-z]:/u.test(link))
          fail(`ASAR_ABSOLUTE_LINK:${path}`)
        const target = normalizeAsarPath(link)
        entries.push({
          path,
          type: 'internal-link',
          bytes: Buffer.byteLength(link),
          sha256: hash(Buffer.from(link)),
          target,
          unpacked: info.unpacked === true
        })
        continue
      }
      if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > MAX_ASAR_ENTRY_BYTES)
        fail(`ASAR_ENTRY_SIZE:${path}`)
      if (info.unpacked !== undefined && typeof info.unpacked !== 'boolean') fail(`ASAR_UNPACKED_TYPE:${path}`)
      totalBytes += info.size
      if (!info.unpacked) budget.admit(info.size)
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_DELIVERED_BYTES) fail('ASAR_TOTAL_BYTE_LIMIT')
      if (info.unpacked) {
        const physical = resolve(unpackedRoot, ...path.split('/'))
        const rel = relative(resolve(unpackedRoot), physical)
        if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '' || isAbsolute(rel))
          fail(`UNPACKED_PATH_ESCAPE:${path}`)
        const physicalStat = lstatSync(physical)
        if (!physicalStat.isFile() || physicalStat.isSymbolicLink() || physicalStat.size !== info.size)
          fail(`UNPACKED_ENTRY_MISMATCH:${path}`)
        realUnpackedRoot ??= realpathSync(unpackedRoot)
        const realPhysical = realpathSync(physical)
        const realRel = relative(realUnpackedRoot, realPhysical)
        if (realRel === '..' || realRel.startsWith(`..${sep}`) || realRel === '' || isAbsolute(realRel))
          fail(`LOOSE_EXTERNAL_SYMLINK:${path}`)
        budget.admit(info.size, realPhysical)
        entries.push({
          path,
          type: 'unpacked-file',
          physicalPath: realPhysical,
          ...(deferHash ? { bytes: info.size } : await shaFile(realPhysical))
        })
        continue
      }
      if (typeof info.offset !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(info.offset))
        fail(`ASAR_RANGE_SCHEMA:${path}`)
      const start = Number.parseInt(info.offset, 10)
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(start + info.size)) fail(`ASAR_RANGE_SCHEMA:${path}`)
      if (info.size > 0) {
        if (packedRanges.some((range) => start < range.end && range.start < start + info.size))
          fail(`ASAR_PACKED_RANGE_OVERLAP:${path}`)
        packedRanges.push({ start, end: start + info.size, path })
      }
      if (8 + headerSize + start + info.size > archiveSize) fail(`ASAR_RANGE_BOUNDS:${path}`)
      const identity = deferHash ? { bytes: info.size } : await shaAsarRange(archive, { ...info, path }, headerSize)
      if (identity.bytes !== info.size) fail(`ASAR_READ_LENGTH:${path}`)
      entries.push({ path, type: 'file', offset: info.offset, ...identity })
    }
  }
  await collect(header.files)
  packedRanges.sort((a, b) => a.start - b.start)
  for (let index = 1; index < packedRanges.length; index += 1)
    if (packedRanges[index].start < packedRanges[index - 1].end)
      fail(`ASAR_PACKED_RANGE_OVERLAP:${packedRanges[index].path}`)
  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  for (const entry of entries.filter((candidate) => candidate.type === 'internal-link')) {
    const visited = new Set([entry.path])
    let target = entry.target
    while (true) {
      if (visited.has(target)) fail(`ASAR_LINK_CYCLE:${entry.path}`)
      visited.add(target)
      const targetEntry = byPath.get(target)
      if (!targetEntry) fail(`ASAR_LINK_TARGET_MISSING:${entry.path}`)
      if (targetEntry.type !== 'internal-link') {
        entry.targetType = targetEntry.type
        break
      }
      target = targetEntry.target
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}
function noOldResidue(entries, knownResidue) {
  const hashes = new Set((knownResidue || []).map((entry) => entry.sha256))
  for (const entry of entries) {
    if (!entry.sha256 || entry.type === 'directory' || entry.type === 'internal-link') continue
    if (hashes.has(entry.sha256)) fail(`EXACT_OLD_ALTERNATE_COPY:${entry.path}`)
  }
}
function rendererExcluded(path, profile) {
  const baseRules = path === 'design-capture.html' || /^assets\/design-capture-/u.test(path) || path.endsWith('.map')
  if (baseRules) return true
  return profile === 'lean' && /^assets\/(?:whisper\.worker-|[^/]*onnxruntime|ort-wasm-)/u.test(path)
}
function assertLeanCandidateRequirements(resourcesRoot, arch, sourceRoot) {
  const requireRegular = (relativePath) => {
    let stat
    try {
      stat = lstatSync(resolve(resourcesRoot, relativePath))
    } catch {
      fail(`LEAN_CANDIDATE_REQUIRED_FILE:${relativePath}`)
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1) fail(`LEAN_CANDIDATE_REQUIRED_FILE:${relativePath}`)
  }
  for (const name of ['operator', 'license-lease', 'cloudflare-embed', 'skills', 'intelligence']) {
    let stat
    try {
      stat = lstatSync(resolve(resourcesRoot, name))
    } catch {
      fail(`LEAN_CANDIDATE_REQUIRED_DIRECTORY:${name}`)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`LEAN_CANDIDATE_REQUIRED_DIRECTORY:${name}`)
  }
  const platform = arch === 'win-x64' ? 'win32' : 'darwin'
  const cpu = arch.split('-').at(-1)
  const folder = `${platform}-${cpu}`
  const ffmpegName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const ffmpegManifest = JSON.parse(readFileSync(resolve(sourceRoot, 'resources/ffmpeg/manifest.json'), 'utf8'))
  if (!/^[a-f0-9]{64}$/u.test(ffmpegManifest.binaries?.[`${folder}/${ffmpegName}`]?.sha256 || ''))
    fail('LEAN_FFMPEG_MANIFEST_TARGET')
  const nodeManifest = JSON.parse(readFileSync(resolve(sourceRoot, 'src/shared/managed-node-manifest.json'), 'utf8'))
  const nodeSpec = nodeManifest.assets?.[platform === 'win32' ? 'win32-x64' : folder]
  if (
    typeof nodeSpec?.nodeRelPath !== 'string' ||
    !/^(?:node\.exe|bin\/node)$/u.test(nodeSpec.nodeRelPath) ||
    !/^[a-f0-9]{64}$/u.test(nodeSpec.sha256 || '')
  )
    fail('LEAN_MANAGED_NODE_MANIFEST_TARGET')
  for (const path of [
    `ffmpeg/${folder}/${ffmpegName}`,
    `managed-node/${platform === 'win32' ? 'win-x64' : folder}/${nodeSpec.nodeRelPath}`,
    platform === 'win32' ? 'vcredist/vc_redist.x64.exe' : 'mac-helper/metis-mac-helper',
    'ffmpeg/manifest.json',
    'ffmpeg/LICENSE.LGPL-2.1.txt',
    'intelligence/index.html',
    'skills/caveman/SKILL.md',
    'graphify_runner.py',
    'THIRD_PARTY_NOTICES.md',
    'icon.png',
    'tray/tray.png',
    'speech-pack-fixtures/en.wav',
    'managed-config.example.json',
    'managed-config.enterprise.example.json'
  ])
    requireRegular(path)
}
async function requiredResourceSources(loose, profile, arch, sourceRoot, resourcesRoot, structuralFixture = false) {
  const mappings = []
  if (profile === 'lean') {
    assertLeanCandidateRequirements(resourcesRoot, arch, sourceRoot)
    const stage = resolve(sourceRoot, 'build/lean-stage/resources')
    if (!structuralFixture)
      for (const name of ['operator', 'license-lease', 'cloudflare-embed', 'skills', 'intelligence']) {
        const directory = resolve(stage, name)
        const stat = lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`LEAN_STAGE_REQUIRED_DIRECTORY:${name}`)
      }
    const inventory = validatePackageInventory(
      JSON.parse(readFileSync(resolve(stage, 'package-inventory.json'), 'utf8'))
    )
    const platform = arch === 'win-x64' ? 'win32' : 'darwin'
    const cpu = arch.split('-').at(-1)
    if (
      inventory.sourceCommit !== process.env.GITHUB_SHA ||
      inventory.profile !== 'lean' ||
      inventory.platform !== platform ||
      inventory.arch !== cpu ||
      inventory.identity !== packageInventoryIdentity(inventory)
    )
      fail('LEAN_STAGE_IDENTITY')
    const packageJson = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(resolve(sourceRoot, 'package-lock.json'), 'utf8'))
    if (
      inventory.appVersion !== packageJson.version ||
      inventory.electronVersion !== lock.packages?.['node_modules/electron']?.version ||
      inventory.electronVersion !== packageJson.devDependencies?.electron
    )
      fail('LEAN_STAGE_VERSION_BINDING')
    const intelligence = inventory.coreFiles.filter((file) => file.path.startsWith('intelligence/'))
    if (!intelligence.some((file) => file.path === 'intelligence/index.html')) fail('LEAN_INTELLIGENCE_INVENTORY')
    const intelligenceSource = (
      await inventoryLoose(
        resolve(sourceRoot, 'intelligence/dist'),
        'intelligence',
        resolve(sourceRoot, 'intelligence/dist')
      )
    )
      .filter((entry) => entry.type === 'file' || entry.type === 'link')
      .map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path))
    if (
      JSON.stringify([...intelligence].sort((a, b) => a.path.localeCompare(b.path))) !==
      JSON.stringify(intelligenceSource)
    )
      fail('LEAN_INTELLIGENCE_SOURCE_SET_MISMATCH')
    for (const file of intelligence) {
      const source = resolve(sourceRoot, 'intelligence/dist', file.path.slice('intelligence/'.length))
      const sourceIdentity = await shaFile(source)
      if (sourceIdentity.bytes !== file.bytes || sourceIdentity.sha256 !== file.sha256)
        fail('LEAN_INTELLIGENCE_SOURCE_MISMATCH')
    }
    const stageFiles = (await inventoryLoose(stage, 'stage', stage))
      .filter((entry) => entry.type === 'file')
      .map((entry) => ({ path: entry.path.slice('stage/'.length), bytes: entry.bytes, sha256: entry.sha256 }))
      .filter((entry) => entry.path !== 'package-inventory.json')
    if (!structuralFixture) {
      const expected = new Map()
      const addSource = async (from, to) => {
        const source = resolve(sourceRoot, from)
        const stat = lstatSync(source)
        const entries = stat.isFile()
          ? [{ path: to, ...(await shaFile(source)) }]
          : (await inventoryLoose(source, to, source))
              .filter((entry) => entry.type === 'file' || entry.type === 'link')
              .map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }))
        for (const entry of entries) {
          if (
            /^(?:cloudflare-embed|operator|license-lease|managed-node\/(?:darwin-arm64|darwin-x64|win-x64)|vcredist)\/\.gitkeep$/u.test(
              entry.path
            )
          )
            continue
          if (expected.has(entry.path)) fail(`LEAN_SOURCE_DUPLICATE:${entry.path}`)
          expected.set(entry.path, { path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })
        }
      }
      for (const [from, to] of [
        ['intelligence/dist', 'intelligence'],
        ['build/managed-config.example.json', 'managed-config.example.json'],
        ['build/managed-config.enterprise.example.json', 'managed-config.enterprise.example.json'],
        ['build/icon.png', 'icon.png'],
        ['build/tray', 'tray'],
        ['resources/graphify_runner.py', 'graphify_runner.py'],
        ['resources/speech-pack-fixtures/en.wav', 'speech-pack-fixtures/en.wav'],
        ['resources/runtime-catalog.json', 'runtime-catalog.json'],
        ['resources/runtime-trust/sigstore-trusted-root.json', 'runtime-trust/sigstore-trusted-root.json'],
        ['resources/runtime-trust/acquisition-receipt.json', 'runtime-trust/acquisition-receipt.json'],
        ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
        ['skills', 'skills'],
        ['build/cloudflare-embed', 'cloudflare-embed'],
        ['resources/operator', 'operator'],
        ['resources/license-lease', 'license-lease'],
        [`resources/ffmpeg/${platform}-${cpu}`, `ffmpeg/${platform}-${cpu}`],
        ['resources/ffmpeg/manifest.json', 'ffmpeg/manifest.json'],
        ['resources/ffmpeg/LICENSE.LGPL-2.1.txt', 'ffmpeg/LICENSE.LGPL-2.1.txt'],
        [
          `resources/managed-node/${platform === 'win32' ? 'win-x64' : `${platform}-${cpu}`}`,
          `managed-node/${platform === 'win32' ? 'win-x64' : `${platform}-${cpu}`}`
        ],
        ...(platform === 'darwin' ? [['resources/mac-helper', 'mac-helper']] : [['resources/vcredist', 'vcredist']])
      ])
        await addSource(from, to)
      const leanMarker = Buffer.from('{"schema":1,"profile":"lean"}\n')
      expected.set('speech-pack-profile.json', {
        path: 'speech-pack-profile.json',
        bytes: leanMarker.length,
        sha256: hash(leanMarker)
      })
      const actual = [...stageFiles].sort((a, b) => a.path.localeCompare(b.path))
      if (
        JSON.stringify(actual) !== JSON.stringify([...expected.values()].sort((a, b) => a.path.localeCompare(b.path)))
      )
        fail('LEAN_STAGE_SOURCE_SET_MISMATCH')
    }
    const targetFolder = `${platform}-${cpu}`
    const managedNodeFolder = platform === 'win32' ? 'win-x64' : targetFolder
    const signedPayloads = new Set([
      `ffmpeg/${targetFolder}/${platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'}`,
      `managed-node/${managedNodeFolder}/${platform === 'win32' ? 'node.exe' : 'bin/node'}`,
      platform === 'win32' ? 'vcredist/vc_redist.x64.exe' : 'mac-helper/metis-mac-helper'
    ])
    const corePaths = new Set(inventory.coreFiles.map((entry) => entry.path))
    if (stageFiles.some((entry) => !corePaths.has(entry.path) && !signedPayloads.has(entry.path)))
      fail('LEAN_STAGE_UNINVENTORIED_FILE')
    for (const file of inventory.coreFiles)
      if (
        !stageFiles.some(
          (entry) => entry.path === file.path && entry.bytes === file.bytes && entry.sha256 === file.sha256
        )
      )
        fail(`LEAN_STAGE_CORE_FILE_MISMATCH:${file.path}`)
    mappings.push({ from: 'build/lean-stage/resources', to: '' })
  } else {
    const builder = readFileSync(resolve(sourceRoot, 'electron-builder.yml'), 'utf8')
    const sections = [builder.slice(0, builder.search(/^mac:/mu))]
    sections.push(
      arch === 'win-x64'
        ? builder.slice(builder.search(/^win:/mu))
        : builder.slice(builder.search(/^mac:/mu), builder.search(/^win:/mu))
    )
    for (const section of sections)
      for (const match of section.matchAll(/^\s+- from: ([^\n]+)\n\s+to: ([^\n]+)/gmu))
        mappings.push({ from: match[1].trim(), to: match[2].trim() })
  }
  if (!mappings.length || (profile === 'full' && !mappings.some((entry) => entry.to === 'intelligence')))
    fail('REQUIRED_RESOURCE_CONFIG_MISSING')
  const sourceByDestination = new Map()
  for (const mapping of mappings) {
    const sourceRootPath = resolve(sourceRoot, mapping.from)
    let sourceRootStat
    try {
      sourceRootStat = lstatSync(sourceRootPath)
    } catch {
      fail(`REQUIRED_RESOURCE_SOURCE_MISSING:${mapping.from}`)
    }
    const resolveContainedSource = (path) => {
      const real = realpathSync(path)
      const rel = relative(sourceRoot, real)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
        fail(`REQUIRED_RESOURCE_SOURCE_LINK:${path}`)
      return real
    }
    const sourceBase = sourceRootStat.isSymbolicLink() ? resolveContainedSource(sourceRootPath) : sourceRootPath
    const expectedDestinations = []
    const activeSources = new Set()
    function collectSource(directory, prefix = '') {
      const realDirectory = realpathSync(directory)
      if (activeSources.has(realDirectory)) fail(`REQUIRED_RESOURCE_SOURCE_CYCLE:${mapping.from}/${prefix}`)
      activeSources.add(realDirectory)
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (item.name === '.gitkeep') continue
        const relativePath = prefix ? `${prefix}/${item.name}` : item.name
        if (
          mapping.from === 'resources/models' &&
          (relativePath === 'onnx-community/whisper-large-v3-turbo' ||
            relativePath.startsWith('onnx-community/whisper-large-v3-turbo/'))
        )
          continue
        if (
          mapping.from === 'resources/local-llm/models' &&
          !['qwen3.5-0.8b/model.gguf', 'qwen3.5-0.8b/mmproj.gguf'].some(
            (allowed) => allowed === relativePath || allowed.startsWith(`${relativePath}/`)
          )
        )
          continue
        if (item.isSymbolicLink()) {
          const target = resolveContainedSource(join(directory, item.name))
          const stat = lstatSync(target)
          if (stat.isDirectory()) collectSource(target, relativePath)
          else if (stat.isFile()) expectedDestinations.push(mapping.to ? `${mapping.to}/${relativePath}` : relativePath)
          else fail(`REQUIRED_RESOURCE_SOURCE_SPECIAL:${mapping.from}/${relativePath}`)
        } else if (item.isDirectory()) collectSource(join(directory, item.name), relativePath)
        else if (item.isFile()) expectedDestinations.push(mapping.to ? `${mapping.to}/${relativePath}` : relativePath)
        else fail(`REQUIRED_RESOURCE_SOURCE_SPECIAL:${mapping.from}/${relativePath}`)
        if (expectedDestinations.length > MAX_ENTRIES) fail('REQUIRED_RESOURCE_SOURCE_COUNT_LIMIT')
      }
      activeSources.delete(realDirectory)
    }
    const sourceBaseStat = lstatSync(sourceBase)
    if (sourceBaseStat.isFile()) expectedDestinations.push(mapping.to)
    else if (sourceBaseStat.isDirectory()) collectSource(sourceBase)
    else fail(`REQUIRED_RESOURCE_SOURCE_TYPE:${mapping.from}`)
    if (mapping.to === 'intelligence' && expectedDestinations.length === 0) fail('REQUIRED_INTELLIGENCE_BUILD_EMPTY')
    const available = new Set(
      loose.filter((entry) => entry.type === 'file' || entry.type === 'link').map((entry) => entry.path)
    )
    for (const destination of expectedDestinations)
      if (!available.has(destination)) fail(`REQUIRED_RESOURCE_MISSING:${destination}`)
    const matching = loose.filter(
      (entry) =>
        (entry.type === 'file' || entry.type === 'link') &&
        (entry.path === mapping.to || entry.path.startsWith(`${mapping.to}/`) || !mapping.to)
    )
    if (!matching.length && expectedDestinations.length) fail(`REQUIRED_RESOURCE_MISSING:${mapping.to}`)
    for (const entry of matching) {
      const suffix =
        mapping.to && entry.path !== mapping.to ? entry.path.slice(mapping.to.length + 1) : mapping.to ? '' : entry.path
      const source = suffix ? `${mapping.from}/${suffix}` : mapping.from
      const physical = resolve(sourceRoot, source)
      let sourceStat
      try {
        sourceStat = lstatSync(physical)
      } catch {
        fail(`REQUIRED_RESOURCE_SOURCE_MISSING:${source}`)
      }
      const physicalSource = sourceStat.isSymbolicLink() ? resolveContainedSource(physical) : physical
      const actualSource = lstatSync(physicalSource)
      if (
        !actualSource.isFile() ||
        actualSource.size !== entry.bytes ||
        (await shaFile(physicalSource)).sha256 !== entry.sha256
      )
        fail(`REQUIRED_RESOURCE_SOURCE_MISMATCH:${source}`)
      sourceByDestination.set(entry.path, source)
    }
  }
  return sourceByDestination
}
async function executableIdentity(resourcesRoot, arch) {
  const relativeExecutable = arch === 'win-x64' ? '../Metis.exe' : '../MacOS/Metis'
  const path = resolve(resourcesRoot, relativeExecutable)
  const fd = openSync(path, 'r')
  const header = Buffer.alloc(256)
  let peHeader = null
  try {
    readSync(fd, header, 0, header.length, 0)
    if (arch === 'win-x64' && header.toString('ascii', 0, 2) === 'MZ') {
      const peOffset = header.readUInt32LE(0x3c)
      if (peOffset >= 64 && peOffset <= 64 * 1024) {
        peHeader = Buffer.alloc(6)
        if (readSync(fd, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) peHeader = null
      }
    }
  } finally {
    closeSync(fd)
  }
  if (arch === 'win-x64') {
    if (
      header.toString('ascii', 0, 2) !== 'MZ' ||
      !peHeader ||
      peHeader.toString('ascii', 0, 4) !== 'PE\0\0' ||
      peHeader.readUInt16LE(4) !== 0x8664
    )
      fail('PACKAGE_EXECUTABLE_ARCH_MISMATCH')
    const optionalField = Buffer.alloc(2)
    const optionalFd = openSync(path, 'r')
    try {
      readSync(optionalFd, optionalField, 0, 2, header.readUInt32LE(0x3c) + 20)
    } finally {
      closeSync(optionalFd)
    }
    const optionalSize = optionalField.readUInt16LE(0)
    if (optionalSize >= 152) {
      const optionalOffset = header.readUInt32LE(0x3c) + 4 + 20
      if (lstatSync(path).size < optionalOffset + optionalSize) fail('PACKAGE_EXECUTABLE_OPTIONAL_HEADER')
      const optionalFields = Buffer.alloc(8)
      const fieldsFd = openSync(path, 'r')
      try {
        readSync(fieldsFd, optionalFields, 0, 2, optionalOffset)
        readSync(fieldsFd, optionalFields, 4, 4, optionalOffset + 108)
      } finally {
        closeSync(fieldsFd)
      }
      if (optionalFields.readUInt16LE(0) !== 0x20b || optionalFields.readUInt32LE(4) < 5)
        fail('PACKAGE_EXECUTABLE_OPTIONAL_HEADER')
      const security = Buffer.alloc(8)
      const securityOffset = header.readUInt32LE(0x3c) + 4 + 20 + 112 + 4 * 8
      const securityFd = openSync(path, 'r')
      try {
        readSync(securityFd, security, 0, security.length, securityOffset)
      } finally {
        closeSync(securityFd)
      }
      if (security.readUInt32LE(0) !== 0 || security.readUInt32LE(4) !== 0)
        fail('SIGNED_CANDIDATE_OUTSIDE_UNSIGNED_SCOPE')
    } else fail('PACKAGE_EXECUTABLE_OPTIONAL_HEADER')
  } else if (arch === 'mac-universal') {
    if (header.readUInt32BE(0) !== 0xcafebabe) fail('PACKAGE_EXECUTABLE_ARCH_MISMATCH')
    const count = header.readUInt32BE(4)
    if (count < 2 || count > 8) fail('PACKAGE_EXECUTABLE_ARCH_MISMATCH')
    const cpuTypes = new Set(Array.from({ length: count }, (_, index) => header.readUInt32BE(8 + index * 20)))
    if (!cpuTypes.has(0x01000007) || !cpuTypes.has(0x0100000c)) fail('PACKAGE_EXECUTABLE_ARCH_MISMATCH')
    const fileSize = lstatSync(path).size
    const fd = openSync(path, 'r')
    try {
      for (let index = 0; index < count; index += 1) {
        const offset = header.readUInt32BE(8 + index * 20 + 8)
        const size = header.readUInt32BE(8 + index * 20 + 12)
        if (offset < 8 + count * 20 || size < 32 || offset + size > fileSize) fail('PACKAGE_EXECUTABLE_FAT_SLICE')
        const slice = Buffer.alloc(32)
        if (
          readSync(fd, slice, 0, 32, offset) !== 32 ||
          slice.readUInt32LE(0) !== 0xfeedfacf ||
          slice.readUInt32LE(4) !== header.readUInt32BE(8 + index * 20)
        )
          fail('PACKAGE_EXECUTABLE_FAT_SLICE')
        const commands = slice.readUInt32LE(16)
        const commandBytes = slice.readUInt32LE(20)
        if (commands > 4096 || commandBytes > 8 * 1024 * 1024 || 32 + commandBytes > size)
          fail('PACKAGE_EXECUTABLE_LOAD_COMMANDS')
        const buffer = Buffer.alloc(commandBytes)
        if (readSync(fd, buffer, 0, buffer.length, offset + 32) !== buffer.length)
          fail('PACKAGE_EXECUTABLE_LOAD_COMMANDS')
        let cursor = 0
        for (let command = 0; command < commands; command += 1) {
          if (cursor + 8 > buffer.length) fail('PACKAGE_EXECUTABLE_LOAD_COMMANDS')
          const commandSize = buffer.readUInt32LE(cursor + 4)
          if (commandSize < 8 || cursor + commandSize > buffer.length) fail('PACKAGE_EXECUTABLE_LOAD_COMMANDS')
          if (buffer.readUInt32LE(cursor) === 0x1d) fail('SIGNED_CANDIDATE_OUTSIDE_UNSIGNED_SCOPE')
          cursor += commandSize
        }
      }
    } finally {
      closeSync(fd)
    }
  } else {
    const cpu = arch === 'mac-arm64' ? 0x0100000c : 0x01000007
    if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== cpu)
      fail('PACKAGE_EXECUTABLE_ARCH_MISMATCH')
    const commands = header.readUInt32LE(16)
    const commandBytes = header.readUInt32LE(20)
    if (commands > 4096 || commandBytes > 8 * 1024 * 1024) fail('PACKAGE_EXECUTABLE_LOAD_COMMANDS')
    if (commands > 0) {
      const fd = openSync(path, 'r')
      const buffer = Buffer.alloc(commandBytes)
      try {
        if (readSync(fd, buffer, 0, buffer.length, 32) !== buffer.length) fail('PACKAGE_EXECUTABLE_LOAD_COMMANDS')
      } finally {
        closeSync(fd)
      }
      let cursor = 0
      for (let index = 0; index < commands; index += 1) {
        if (cursor + 8 > buffer.length) fail('PACKAGE_EXECUTABLE_LOAD_COMMANDS')
        const size = buffer.readUInt32LE(cursor + 4)
        if (size < 8 || cursor + size > buffer.length) fail('PACKAGE_EXECUTABLE_LOAD_COMMANDS')
        if (buffer.readUInt32LE(cursor) === 0x1d) fail('SIGNED_CANDIDATE_OUTSIDE_UNSIGNED_SCOPE')
        cursor += size
      }
    }
  }
  return { relativePath: relativeExecutable, signatureStatus: 'unsigned-executable-header', ...(await shaFile(path)) }
}
async function validateReceipt(
  receipt,
  { build, buildSha256, profile, arch, archiveIdentity, loose, sourceByDestination, resourcesRoot }
) {
  const run = build.buildRun
  const expectedRunnerOs = arch === 'win-x64' ? 'Windows' : 'macOS'
  const executable = await executableIdentity(resourcesRoot, arch)
  if (
    receipt?.schema !== 1 ||
    receipt.sourceCommit !== process.env.GITHUB_SHA ||
    receipt.runId !== process.env.GITHUB_RUN_ID ||
    receipt.runAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
    typeof receipt.job !== 'string' ||
    !receipt.job ||
    receipt.runnerOs !== process.env.RUNNER_OS ||
    run.runnerOs !== expectedRunnerOs ||
    receipt.runnerOs !== expectedRunnerOs ||
    receipt.profile !== profile ||
    receipt.packageTarget !== arch ||
    receipt.packageTool !== 'electron-builder' ||
    receipt.signatureScope !== 'pre-sign-source-equal-app-tree' ||
    receipt.executable?.relativePath !== executable.relativePath ||
    receipt.executable?.sha256 !== executable.sha256 ||
    receipt.executable?.bytes !== executable.bytes ||
    receipt.executable?.signatureStatus !== executable.signatureStatus ||
    (arch === 'mac-universal' && run.macUniversal !== '1') ||
    (profile === 'lean' &&
      process.env.METIS_PACKAGE_ARCH &&
      process.env.METIS_PACKAGE_ARCH !== arch.split('-').at(-1)) ||
    receipt.buildEvidenceSha256 !== buildSha256 ||
    receipt.packageExitCode !== 0 ||
    receipt.appAsarSha256 !== archiveIdentity.sha256 ||
    JSON.stringify(receipt.configurationHashes) !== JSON.stringify(run.configurationHashes) ||
    !Array.isArray(receipt.looseResources) ||
    !Array.isArray(receipt.fontAttributions)
  )
    fail('CANDIDATE_RECEIPT_BINDING')
  const actual = loose
    .filter((entry) => entry.type === 'file' || entry.type === 'link')
    .map((entry) => {
      const source = sourceByDestination.get(entry.path)
      if (!source) fail(`CANDIDATE_RESOURCE_ORIGIN_MISSING:${entry.path}`)
      return { path: entry.path, source, bytes: entry.bytes, sha256: entry.sha256 }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
  const expected = receipt.looseResources
    .map((entry) => {
      if (
        typeof entry.source !== 'string' ||
        !entry.source ||
        entry.source.startsWith('/') ||
        entry.source.split(/[\\/]/u).includes('..')
      )
        fail('CANDIDATE_RESOURCE_SOURCE_IDENTITY')
      return { path: entry.path, source: entry.source, bytes: entry.bytes, sha256: entry.sha256 }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
  if (!actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) fail('CANDIDATE_LOOSE_RESOURCE_INVENTORY')
  return {
    packageExitCode: receipt.packageExitCode,
    packageTarget: receipt.packageTarget,
    executable,
    looseResourceCount: actual.length
  }
}
function validateFontAttributions(receipt, delivered, packageLicenses, noticeText, notice, sourceRoot) {
  const fontEntries = delivered.filter(
    (entry) => entry.type !== 'directory' && /\.(?:woff2?|ttf|otf)$/iu.test(entry.path)
  )
  const licenses = new Map(packageLicenses.map((license) => [license.package, license]))
  const sources = new Map()
  const katexFontRoot = resolve(sourceRoot, 'node_modules/katex/dist/fonts')
  for (const name of readdirSync(katexFontRoot)) {
    const path = resolve(katexFontRoot, name)
    const stat = lstatSync(path)
    if (stat.isFile())
      sources.set(hash(readFileSync(path)), {
        owner: 'katex',
        path: `node_modules/katex/dist/fonts/${name}`,
        bytes: stat.size
      })
  }
  for (const [owner, name] of [
    ['geist', 'geist-sans.woff2'],
    ['inter', 'inter.woff2']
  ]) {
    const path = `src/renderer/src/assets/fonts/${name}`
    const bytes = readFileSync(resolve(sourceRoot, path))
    const expectedHash =
      owner === 'geist'
        ? '0cbbe6286a00f356e98980783cc950a9b693751e04aedfb97d9526ff6dc2b316'
        : '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62'
    if (hash(bytes) !== expectedHash) fail(`FONT_COMMITTED_SOURCE_CHANGED:${owner}`)
    sources.set(hash(bytes), {
      owner,
      path,
      bytes: bytes.length,
      upstream:
        owner === 'geist'
          ? {
              package: '@fontsource-variable/geist@5.2.8',
              member: 'files/geist-latin-wght-normal.woff2',
              archiveIntegrity:
                'sha512-cJ6m9e+8MQ5dCYJsLylfZrgBh6KkG4bOLckB35Tr9J/EqdkEM6QllH5PxqP1dhTvFup+HtMRPuz9xOjxXJggxw==',
              licenseMemberSha256: 'cc27b0f563500a9e0658866241d06d05ef20a9efbf8bac47fe0499a65ede5952'
            }
          : {
              package: '@fontsource-variable/inter@5.3.0',
              member: 'files/inter-latin-wght-normal.woff2',
              archiveIntegrity:
                'sha512-OupL48va4JNofb97w6NYeF9S7W/kHNKM0Er8Dem5nqi4jeOLrVJDoE8tZEpnMJmtkvNbB1EIPPwHcdkF6b1oUA==',
              licenseMemberSha256: '3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345'
            }
    })
  }
  const oflSource = readFileSync(resolve(sourceRoot, 'node_modules/@fontsource-variable/inter/LICENSE'), 'utf8')
  if (hash(Buffer.from(oflSource)) !== '3b0a5fca3d17942cde889069889dedbbbd075e9b599968c82a95f4d944e9b345')
    fail('OFL_UPSTREAM_SOURCE_IDENTITY')
  const marker = 'SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007'
  const oflEnd = 'OTHER DEALINGS IN THE FONT SOFTWARE.'
  const normalizedTerms = (text) =>
    text
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim()
  const sourceTerms = normalizedTerms(oflSource.slice(oflSource.indexOf(marker)))
  if (hash(Buffer.from(sourceTerms)) !== 'a79eba37ac2bb75da2e17e0854aeeeebaa7e4a49fb120e63162f333df394831d')
    fail('OFL_UPSTREAM_TERMS_IDENTITY')
  const noticeStart = noticeText.indexOf(marker)
  const noticeEnd = noticeText.indexOf(oflEnd, noticeStart)
  const noticeTerms =
    noticeStart >= 0 && noticeEnd > noticeStart
      ? normalizedTerms(noticeText.slice(noticeStart, noticeEnd + oflEnd.length))
      : ''
  const fontNoticeComplete =
    noticeTerms === sourceTerms &&
    noticeText.includes('Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)') &&
    noticeText.includes('Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)')
  if (!fontNoticeComplete && fontEntries.some((entry) => ['geist', 'inter'].includes(sources.get(entry.sha256)?.owner)))
    fail('OFL_TERMS_NOT_DELIVERED')
  if (fontNoticeComplete)
    for (const owner of ['geist', 'inter'])
      licenses.set(owner, {
        package: owner,
        sha256: hash(Buffer.from(noticeText)),
        deliveredPaths: [`${notice.origin}:${notice.path}`]
      })
  const expected = new Set(fontEntries.map((entry) => `${entry.origin}\0${entry.path}\0${entry.sha256}`))
  const seen = new Set()
  for (const attribution of receipt.fontAttributions) {
    if (
      !attribution ||
      typeof attribution !== 'object' ||
      Array.isArray(attribution) ||
      !['asar', 'asar-unpacked-physical', 'loose-resource'].includes(attribution.origin) ||
      typeof attribution.path !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(attribution.sha256 || '')
    )
      fail('FONT_ATTRIBUTION_SCHEMA')
    const key = `${attribution.origin}\0${attribution.path}\0${attribution.sha256}`
    const source = sources.get(attribution.sha256)
    const license = source && licenses.get(source.owner)
    const deliveredFont = fontEntries.find(
      (entry) =>
        entry.origin === attribution.origin && entry.path === attribution.path && entry.sha256 === attribution.sha256
    )
    if (
      !expected.has(key) ||
      seen.has(key) ||
      !source ||
      !deliveredFont ||
      source.bytes !== deliveredFont.bytes ||
      attribution.sourcePath !== source.path ||
      attribution.licensePackage !== source.owner ||
      !license ||
      attribution.licenseSha256 !== license.sha256
    )
      fail(`FONT_ATTRIBUTION_BINDING:${attribution.path}`)
    seen.add(key)
  }
  if (seen.size !== expected.size) fail('FONT_ATTRIBUTION_INCOMPLETE')
  return fontEntries.map((entry) => {
    const attribution = receipt.fontAttributions.find(
      (item) => item.origin === entry.origin && item.path === entry.path && item.sha256 === entry.sha256
    )
    const license = licenses.get(attribution.licensePackage)
    return {
      origin: entry.origin,
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
      licensePackage: attribution.licensePackage,
      sourcePath: attribution.sourcePath,
      upstream: sources.get(entry.sha256)?.upstream,
      licenseSha256: license.sha256,
      deliveredLicensePaths: license.deliveredPaths
    }
  })
}
async function scanDeliveredSources({ archive, unpackedRoot, asar, delivered, sourceByDestination, sourceRoot }) {
  const asarByPath = new Map(asar.map((entry) => [entry.path, entry]))
  const hits = []
  for (const entry of delivered) {
    if (entry.type === 'directory' || entry.type === 'link-directory' || entry.type === 'internal-link') continue
    if (entry.bytes > 32 * 1024 * 1024) {
      const archived = entry.origin === 'asar' ? asarByPath.get(entry.path) : null
      const packed = archived?.type === 'file'
      const rangeStart = packed ? 8 + getRawHeader(archive).headerSize + Number.parseInt(archived.offset, 10) : 0
      const sourcePath = packed ? archive : entry.physicalPath
      if (!sourcePath) fail(`LARGE_SOURCE_UNCLASSIFIED:${entry.path}`)
      const fd = openSync(sourcePath, 'r')
      const prefix = Buffer.alloc(4096)
      const suffix = Buffer.alloc(16)
      try {
        readSync(fd, prefix, 0, prefix.length, rangeStart)
        readSync(fd, suffix, 0, suffix.length, rangeStart + entry.bytes - suffix.length)
      } finally {
        closeSync(fd)
      }
      if (isCodeContainerPrefix(prefix)) fail(`NESTED_CODE_CONTAINER_UNCLASSIFIED:${entry.path}`)
      const nativePath =
        /\.(?:node|exe|dll|so|dylib)$/iu.test(entry.path) ||
        /^(?:managed-node\/(?:darwin-arm64|darwin-x64)\/bin\/node|ffmpeg\/(?:darwin-arm64|darwin-x64)\/ffmpeg|mac-helper\/metis-mac-helper)$/u.test(
          entry.path
        )
      const native = nativePath && isStructuredNative(prefix, entry.bytes)
      const wasm =
        /\.wasm$/iu.test(entry.path) && prefix.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))
      const model =
        /\.gguf$/iu.test(entry.path) &&
        prefix.toString('ascii', 0, 4) === 'GGUF' &&
        [2, 3].includes(prefix.readUInt32LE(4)) &&
        entry.origin === 'loose-resource' &&
        /(?:^|\/)models\//u.test(sourceByDestination.get(entry.path) || '')
      const media =
        (/\.png$/iu.test(entry.path) &&
          prefix.subarray(0, 16).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])) &&
          suffix.subarray(4, 12).equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68]))) ||
        (/\.jpe?g$/iu.test(entry.path) &&
          prefix.subarray(0, 3).equals(Buffer.from([255, 216, 255])) &&
          suffix.subarray(14).equals(Buffer.from([255, 217])))
      if (!native && !wasm && !model && !media) fail(`LARGE_SOURCE_UNCLASSIFIED:${entry.path}`)
      const authorized = entry.origin === 'loose-resource' ? sourceByDestination.get(entry.path) : entry.path
      if (!authorized || authorized.startsWith('/') || authorized.split(/[\\/]/u).includes('..'))
        fail(`LARGE_SOURCE_UNCLASSIFIED:${entry.path}`)
      let sourceIdentity
      try {
        sourceIdentity = await shaFile(resolve(sourceRoot, authorized))
      } catch {
        fail(`LARGE_SOURCE_UNCLASSIFIED:${entry.path}`)
      }
      if (sourceIdentity.bytes !== entry.bytes || sourceIdentity.sha256 !== entry.sha256)
        fail(`LARGE_SOURCE_IDENTITY_MISMATCH:${entry.path}`)
      const stream = packed
        ? createReadStream(archive, { start: rangeStart, end: rangeStart + entry.bytes - 1 })
        : createReadStream(sourcePath)
      let tail = Buffer.alloc(0)
      let scanned = 0
      for await (const chunk of stream) {
        scanned += chunk.length
        if (scanned > MAX_ASAR_ENTRY_BYTES) fail(`LARGE_SOURCE_SCAN_LIMIT:${entry.path}`)
        const window = Buffer.concat([tail, chunk])
        if (
          window.includes(Buffer.from('sourceMappingURL')) ||
          OLD_MARKERS.some((marker) => window.includes(Buffer.from(marker))) ||
          /(?:katex@0\.16\.47|version\s*=\s*["']0\.16\.47["'])/iu.test(window.toString('latin1'))
        )
          fail(`OLD_KATEX_SOURCE_OR_MAP:${entry.path}`)
        tail = window.subarray(Math.max(0, window.length - 256))
      }
      if (scanned !== entry.bytes) fail(`LARGE_SOURCE_SCAN_LENGTH:${entry.path}`)
      continue
    }
    let bytes
    if (entry.origin === 'asar') {
      const archived = asarByPath.get(entry.path)
      if (archived?.type === 'unpacked-file') bytes = readFileSync(join(unpackedRoot, ...archived.path.split('/')))
      else if (archived?.type === 'file') bytes = extractFile(archive, nativeAsarMember(archived.path))
      else fail(`DELIVERED_ASAR_ORIGIN_MISSING:${entry.path}`)
    } else bytes = readFileSync(entry.physicalPath)
    if (isCodeContainerPrefix(bytes)) fail(`NESTED_CODE_CONTAINER_UNCLASSIFIED:${entry.path}`)
    if (OLD_MARKERS.some((marker) => bytes.includes(Buffer.from(marker))) || findEmbeddedOldKaTeX(entry.path, bytes))
      hits.push(`${entry.origin}:${entry.path}`)
  }
  if (hits.length) fail(`OLD_KATEX_SOURCE_OR_MAP:${hits.slice(0, 8).join(',')}`)
  return {
    scannedExecutableAndMapCount: delivered.filter((entry) => /\.(?:js|mjs|cjs|map|css)$/iu.test(entry.path)).length,
    markerHits: []
  }
}
export async function inspectCandidate({
  resources,
  buildEvidence,
  candidateReceipt,
  profile,
  arch,
  sourceRoot = process.cwd(),
  structuralFixture = false,
  structuralByteLimit = /** @type {number | null} */ (null),
  katexTarball = null
}) {
  if (typeof candidateReceipt !== 'string' || !candidateReceipt) fail('CANDIDATE_RECEIPT_REQUIRED')
  if (structuralFixture) {
    if (process.env.VITEST !== 'true') fail('STRUCTURAL_FIXTURE_ONLY_IN_VITEST')
    if (
      structuralByteLimit !== null &&
      (!Number.isSafeInteger(structuralByteLimit) ||
        structuralByteLimit <= 0 ||
        structuralByteLimit > MAX_DELIVERED_BYTES)
    )
      fail('STRUCTURAL_BYTE_LIMIT_SCHEMA')
  } else {
    if (structuralByteLimit !== null) fail('STRUCTURAL_BYTE_LIMIT_ONLY_IN_VITEST')
    if (realpathSync(sourceRoot) !== realpathSync(process.cwd())) fail('SOURCE_CHECKOUT_ROOT')
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim()
    const changes = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: sourceRoot,
      encoding: 'utf8'
    }).trim()
    if (head !== process.env.GITHUB_SHA || changes) fail('SOURCE_CHECKOUT_COMMIT_OR_CLEANLINESS')
  }
  sourceRoot = realpathSync(sourceRoot)
  const root = realpathSync(resources)
  const budget = admissionBudget(structuralByteLimit ?? MAX_DELIVERED_BYTES)
  const archive = join(root, 'app.asar')
  const archiveStat = lstatSync(archive)
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size === 0) fail('APP_ASAR_MISSING')
  const unpackedRoot = join(root, 'app.asar.unpacked')
  const asar = await asarInventory(archive, unpackedRoot, budget, true)
  const unpacked = await inventoryLoose(unpackedRoot, 'app.asar.unpacked', unpackedRoot, budget, true)
  const asarUnpackedPaths = asar
    .filter((entry) => entry.type === 'unpacked-file' || (entry.type === 'internal-link' && entry.unpacked))
    .map((entry) => entry.path)
    .sort()
  const unpackedDirectoryLinks = asar
    .filter((entry) => entry.type === 'internal-link' && entry.unpacked && entry.targetType === 'directory')
    .map((entry) => entry.path)
  const physicalUnpackedPaths = unpacked
    .filter(
      (entry) =>
        (entry.type === 'file' || entry.type === 'link' || entry.type === 'link-directory') &&
        !unpackedDirectoryLinks.some((path) => entry.path.slice('app.asar.unpacked/'.length).startsWith(`${path}/`))
    )
    .map((entry) => entry.path.slice('app.asar.unpacked/'.length))
    .sort()
  if (JSON.stringify(asarUnpackedPaths) !== JSON.stringify(physicalUnpackedPaths))
    fail('UNPACKED_TREE_INVENTORY_MISMATCH')
  for (const entry of asar.filter((candidate) => candidate.type === 'internal-link' && candidate.unpacked)) {
    const physical = unpacked.find((candidate) => candidate.path === `app.asar.unpacked/${entry.path}`)
    if (
      physical?.type !== (entry.targetType === 'directory' ? 'link-directory' : 'link') ||
      physical.target !== entry.target
    )
      fail(`UNPACKED_LINK_TARGET_MISMATCH:${entry.path}`)
  }
  const loose = []
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'app.asar' || entry.name === 'app.asar.unpacked') continue
    const path = join(root, entry.name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) loose.push(...(await inventoryLoose(path, entry.name, root, budget, true)))
    else if (stat.isDirectory()) loose.push(...(await inventoryLoose(path, entry.name, root, budget, true)))
    else if (stat.isFile()) {
      budget.admit(stat.size, path)
      loose.push({ path: entry.name, type: 'file', physicalPath: path, bytes: stat.size })
    } else fail(`RESOURCE_SPECIAL_ENTRY:${entry.name}`)
  }
  const asarDelivered = asar.map((entry) => ({ ...entry, origin: 'asar' }))
  const physicalUnpacked = unpacked.map((entry) => ({
    ...entry,
    path: entry.path.slice('app.asar.unpacked/'.length),
    origin: 'asar-unpacked-physical'
  }))
  const looseDelivered = loose.map((entry) => ({ ...entry, origin: 'loose-resource' }))
  const delivered = [...asarDelivered, ...physicalUnpacked, ...looseDelivered]
  const deliveredCount = asar.length + unpacked.length + loose.length
  if (deliveredCount > MAX_ENTRIES) fail('DELIVERED_ENTRY_COUNT_LIMIT')
  const physicalBytes = new Map()
  const deliveredBytes = [
    ...asar.filter((entry) => entry.type === 'file'),
    ...unpacked.filter((entry) => entry.type === 'file' || entry.type === 'link'),
    ...loose.filter((entry) => entry.type === 'file' || entry.type === 'link')
  ].reduce((total, entry) => {
    if (!entry.physicalPath) return total + entry.bytes
    const prior = physicalBytes.get(entry.physicalPath)
    if (prior !== undefined) {
      if (prior !== entry.bytes) fail('DELIVERED_PHYSICAL_SIZE_CHANGED')
      return total
    }
    physicalBytes.set(entry.physicalPath, entry.bytes)
    return total + entry.bytes
  }, 0)
  if (!Number.isSafeInteger(deliveredBytes) || deliveredBytes > MAX_DELIVERED_BYTES) fail('DELIVERED_TOTAL_BYTE_LIMIT')
  const logicalArchivePaths = new Set(
    asar
      .filter((entry) => entry.type !== 'directory')
      .map((entry) => entry.path.normalize('NFC').toLocaleLowerCase('en-US'))
  )
  for (const entry of looseDelivered)
    if (logicalArchivePaths.has(entry.path.normalize('NFC').toLocaleLowerCase('en-US')))
      fail(`DELIVERED_CROSS_NAMESPACE_COLLISION:${entry.path}`)
  const namespacePaths = new Set()
  for (const entry of delivered) {
    const key = `${entry.origin}\0${entry.path.normalize('NFC').toLocaleLowerCase('en-US')}`
    if (namespacePaths.has(key)) fail('DELIVERED_NAMESPACE_COLLISION')
    namespacePaths.add(key)
    if (entry.type === 'file' && /\.(?:asar|zip|jar)$/iu.test(entry.path))
      fail(`NESTED_CODE_CONTAINER_UNCLASSIFIED:${entry.path}`)
  }
  const asarHeaderSize = getRawHeader(archive).headerSize
  for (const entry of asar) {
    if (entry.type === 'file')
      Object.assign(
        entry,
        await shaAsarRange(archive, { offset: entry.offset, size: entry.bytes, path: entry.path }, asarHeaderSize)
      )
    else if (entry.type === 'unpacked-file') Object.assign(entry, await shaFile(entry.physicalPath))
  }
  for (const entry of [...unpacked, ...loose])
    if (entry.type === 'file' || entry.type === 'link') Object.assign(entry, await shaFile(entry.physicalPath))
  for (let index = 0; index < asar.length; index += 1) Object.assign(asarDelivered[index], asar[index])
  for (let index = 0; index < unpacked.length; index += 1)
    if (unpacked[index].sha256) physicalUnpacked[index].sha256 = unpacked[index].sha256
  for (let index = 0; index < loose.length; index += 1)
    if (loose[index].sha256) looseDelivered[index].sha256 = loose[index].sha256
  const buildBytes = readFileSync(buildEvidence)
  if (buildBytes.length === 0 || buildBytes.length > 64 * 1024 * 1024) fail('BUILD_EVIDENCE_SIZE')
  const build = JSON.parse(buildBytes.toString('utf8'))
  if (
    build.schema !== 2 ||
    build.evidence !== 'PRODUCTION_RENDERER_GRAPH_AND_BYTES_VERIFIED' ||
    build.sourceCommit !== process.env.GITHUB_SHA ||
    !Number.isSafeInteger(build.ordinaryObservedByteEquality?.fileCount) ||
    build.ordinaryObservedByteEquality.fileCount <= 0 ||
    !/^[a-f0-9]{64}$/u.test(build.ordinaryObservedByteEquality?.sha256 || '') ||
    !Array.isArray(build.ordinaryInventory) ||
    !Array.isArray(build.observedInventory) ||
    !Array.isArray(build.mermaidResidue?.knownEmbeddedOldKaTeX) ||
    build.buildRun?.schema !== 1 ||
    build.buildRun.sourceCommit !== process.env.GITHUB_SHA ||
    build.buildRun.runId !== process.env.GITHUB_RUN_ID ||
    build.buildRun.runAttempt !== process.env.GITHUB_RUN_ATTEMPT ||
    !build.buildRun.job ||
    build.buildRun.runnerOs !== process.env.RUNNER_OS ||
    build.buildRun.profile !== profile ||
    build.buildRun.packageTarget !== arch ||
    build.buildRun.ordinaryBuildExitCode !== 0 ||
    build.buildRun.observedBuildExitCode !== 0
  )
    fail('BUILD_EVIDENCE_REQUIRED')
  const equality = compareInventories(build.ordinaryInventory, build.observedInventory)
  if (
    equality.fileCount !== build.ordinaryObservedByteEquality.fileCount ||
    equality.sha256 !== build.ordinaryObservedByteEquality.sha256
  )
    fail('BUILD_INVENTORY_HASH_MISMATCH')
  const requiredConfigPaths = [
    'electron.vite.config.ts',
    'package.json',
    'package-lock.json',
    'electron-builder.yml',
    'electron-builder.win.yml',
    'scripts/before-pack.mjs',
    'scripts/design/renderer-inputs.ts'
  ]
  const actualConfigHashes = Object.fromEntries(
    requiredConfigPaths.map((path) => [path, hash(readFileSync(resolve(sourceRoot, path)))])
  )
  if (
    JSON.stringify(build.buildRun.configurationHashes) !== JSON.stringify(actualConfigHashes) ||
    actualConfigHashes['package.json'] !== 'dddf43f8fcd0a8b353b5b29ed9fa316486a668955ad56161e707f71f56b2ad06' ||
    actualConfigHashes['package-lock.json'] !== 'f2cedcad1b2b67c9f9fb780d24ab6c8dde6dfa65ae0a76432038450d2a41746c'
  )
    fail('BUILD_SOURCE_CONFIG_BINDING')
  const graphPath = resolve(dirname(buildEvidence), 'renderer-graph.json')
  const graphBytes = readFileSync(graphPath)
  if (graphBytes.length === 0 || graphBytes.length > 64 * 1024 * 1024 || hash(graphBytes) !== build.graphSha256)
    fail('BUILD_GRAPH_HASH_MISMATCH')
  const graph = JSON.parse(graphBytes.toString('utf8'))
  if (!structuralFixture) {
    if (!katexTarball) fail('KATEX_ARCHIVE_REQUIRED')
    const archiveProof = await validateKaTeXArchive({ root: sourceRoot, tarball: katexTarball, graph })
    if (JSON.stringify(archiveProof) !== JSON.stringify(build.katexArchive)) fail('BUILD_ARCHIVE_PRODUCER_MISMATCH')
  }
  if (
    graph.config?.outerConfig?.path !== 'electron.vite.config.ts' ||
    !Array.isArray(graph.config.outerConfig.files) ||
    !graph.config.outerConfig.files.some((entry) => entry.path === 'scripts/design/renderer-inputs.ts') ||
    graph.config.outerConfig.files.some(
      (entry) =>
        typeof entry.path !== 'string' ||
        !entry.path ||
        entry.path.startsWith('/') ||
        entry.path.split('/').includes('..') ||
        hash(readFileSync(resolve(sourceRoot, entry.path))) !== entry.sha256
    )
  )
    fail('BUILD_OUTER_CONFIG_BINDING')
  if (
    JSON.stringify(await validateGraph(graph, build.observedInventory, sourceRoot)) !== JSON.stringify(build.graph) ||
    JSON.stringify(graph.buildRun) !== JSON.stringify(build.buildRun) ||
    build.katexArchive?.installedPackageBytesMatchSRIArchive !== true ||
    build.katexArchive?.integrity !==
      'sha512-3snve4y0SXTMequLim1FMiPvLGElySam0blN5xQZBqEY3lOJz1TnuaaiugnBZBqHzlSAGmFTYL7MCQkORuLKCA==' ||
    build.katexArchive?.archiveSha256 !== 'a71df261a7080b53a4be44ea1b40e8e73e84cdd5d3311239310568e76437c018' ||
    !Array.isArray(build.mermaidResidue?.knownEmbeddedOldKaTeX) ||
    build.mermaidResidue.knownEmbeddedOldKaTeX.length === 0 ||
    build.mermaidResidue.embeddedComponentAddendum?.advisory !== 'GHSA-238p-pmpm-9mq7 / CVE-2026-103923' ||
    build.mermaidResidue.embeddedComponentAddendum?.shippedStatus?.startsWith('UNKNOWN') !== true
  )
    fail('BUILD_GRAPH_OR_ARCHIVE_MISMATCH')
  for (const member of build.mermaidResidue.knownEmbeddedOldKaTeX) {
    if (
      !/^node_modules\/mermaid\/dist\//u.test(member.path || '') ||
      !/^[a-f0-9]{64}$/u.test(member.sha256 || '') ||
      member.version !== '0.16.47'
    )
      fail('BUILD_RESIDUE_MEMBER_SCHEMA')
    const bytes = readFileSync(resolve(sourceRoot, member.path))
    if (bytes.length !== member.bytes || hash(bytes) !== member.sha256 || !findEmbeddedOldKaTeX(member.path, bytes))
      fail('BUILD_RESIDUE_MEMBER_BYTES')
  }
  const completeResidue = (await inventoryTree(resolve(sourceRoot, 'node_modules/mermaid/dist')))
    .map((entry) => ({ ...entry, path: `node_modules/mermaid/dist/${entry.path}` }))
    .filter((entry) => findEmbeddedOldKaTeX(entry.path, readFileSync(resolve(sourceRoot, entry.path))))
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256, version: '0.16.47' }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const declaredResidue = build.mermaidResidue.knownEmbeddedOldKaTeX
    .map(({ path, bytes, sha256, version }) => ({ path, bytes, sha256, version }))
    .sort((a, b) => a.path.localeCompare(b.path))
  if (
    JSON.stringify(completeResidue) !== JSON.stringify(declaredResidue) ||
    JSON.stringify(build.mermaidResidue.embeddedComponentAddendum.installedMembers) !==
      JSON.stringify(build.mermaidResidue.knownEmbeddedOldKaTeX)
  )
    fail('BUILD_RESIDUE_MEMBER_SET')
  const renderer = new Map(
    asar
      .filter((entry) => entry.path.startsWith('out/renderer/') && entry.type !== 'directory')
      .map((entry) => [entry.path.slice('out/renderer/'.length), entry])
  )
  const expectedRenderer = build.ordinaryInventory
  if (!Array.isArray(expectedRenderer) || expectedRenderer.length === 0) fail('BUILD_INVENTORY_MISSING')
  const expectedIncluded = expectedRenderer.filter((entry) => !rendererExcluded(entry.path, profile))
  const expectedExcluded = expectedRenderer.filter((entry) => rendererExcluded(entry.path, profile))
  for (const entry of expectedIncluded) {
    const packaged = renderer.get(entry.path)
    if (!packaged || packaged.bytes !== entry.bytes || packaged.sha256 !== entry.sha256)
      fail(`RENDERER_BUILD_MISMATCH:${entry.path}`)
  }
  if (renderer.size !== expectedIncluded.length) fail('RENDERER_EXTRA_OR_MISSING')
  noOldResidue(delivered, build.mermaidResidue.knownEmbeddedOldKaTeX)
  const notices = delivered.filter(
    (entry) => /(^|\/)THIRD_PARTY_NOTICES\.md$/u.test(entry.path) && entry.type !== 'directory'
  )
  if (notices.length !== 1) fail('NOTICE_INVENTORY')
  const notice = notices[0]
  let noticeBytes
  if (notice.origin === 'asar') {
    const noticeEntry = asar.find((entry) => entry.path === notice.path)
    noticeBytes =
      noticeEntry?.type === 'unpacked-file'
        ? readFileSync(join(unpackedRoot, ...noticeEntry.path.split('/')))
        : extractFile(archive, nativeAsarMember(notice.path))
  } else noticeBytes = readFileSync(notice.physicalPath)
  const noticeText = Buffer.from(noticeBytes).toString('utf8')
  const packageLicenses = ['katex', 'mermaid', 'streamdown'].map((name) => {
    const path = resolve(sourceRoot, 'node_modules', name, 'LICENSE')
    const content = readFileSync(path)
    if (content.length < 512) fail(`LICENSE_SOURCE_INCOMPLETE:${name}`)
    const identity = hash(content)
    const candidates = delivered.filter(
      (entry) => entry.path.endsWith(`/node_modules/${name}/LICENSE`) || entry.path === `node_modules/${name}/LICENSE`
    )
    const exactPaths = candidates
      .filter((entry) => entry.sha256 === identity && entry.bytes === content.length)
      .map((entry) => `${entry.origin}:${entry.path}`)
    const copiedTree = delivered.some(
      (entry) =>
        entry.path === `node_modules/${name}` ||
        entry.path.startsWith(`node_modules/${name}/`) ||
        entry.path.includes(`/node_modules/${name}/`)
    )
    if (copiedTree && (!candidates.length || exactPaths.length !== candidates.length))
      fail(`PACKAGE_LICENSE_NOT_PRESERVED:${name}`)
    const noticeContainsMaterial = noticeText.includes(content.toString('utf8').trim())
    if (!exactPaths.length && !noticeContainsMaterial) fail(`LICENSE_MATERIAL_NOT_DELIVERED:${name}`)
    return {
      package: name,
      bytes: content.length,
      sha256: identity,
      deliveredPaths: exactPaths.length ? exactPaths : [`${notice.origin}:${notice.path}`]
    }
  })
  const apacheSource = readFileSync(resolve(sourceRoot, 'node_modules/typescript/LICENSE.txt'))
  if (hash(apacheSource) !== 'a7d00bfd54525bc694b6e32f64c7ebcf5e6b7ae3657be5cc12767bce74654a47')
    fail('APACHE_TERMS_SOURCE_IDENTITY')
  const normalizeLegal = (value) => value.replace(/\r\n/gu, '\n').trim()
  const apacheTerms = normalizeLegal(apacheSource.toString('utf8'))
  const legalLocations = delivered.filter(
    (entry) =>
      entry.type === 'file' &&
      /(?:LICENSE|COPYING|NOTICE|THIRD_PARTY_NOTICES)/iu.test(entry.path) &&
      entry.bytes <= 64 * 1024
  )
  let fullApacheLocation = null
  for (const entry of legalLocations) {
    const bytes =
      entry.origin === 'asar' ? extractFile(archive, nativeAsarMember(entry.path)) : readFileSync(entry.physicalPath)
    if (normalizeLegal(bytes.toString('utf8')).includes(apacheTerms)) {
      fullApacheLocation = `${entry.origin}:${entry.path}`
      break
    }
  }
  if (!fullApacheLocation) fail('APACHE_2_0_TERMS_NOT_DELIVERED')
  if (!/copyright/i.test(noticeText)) fail('NOTICE_COPYRIGHT_MISSING')
  const archiveIdentity = await shaFile(archive)
  const packageIdentity = asar.find((entry) => entry.path === 'package.json' && entry.type === 'file')
  if (!packageIdentity) fail('PACKAGED_PROFILE_MARKER_MISSING')
  const packagedManifest = JSON.parse(extractFile(archive, nativeAsarMember('package.json')).toString('utf8'))
  if (profile === 'lean') {
    if (packagedManifest.metisPackageProfile !== 'lean') fail('PACKAGED_PROFILE_MARKER_MISMATCH')
  } else {
    const marker = loose.find((entry) => entry.path === 'speech-pack-profile.json' && entry.type === 'file')
    if (
      packagedManifest.metisPackageProfile !== undefined ||
      !marker ||
      readFileSync(marker.physicalPath, 'utf8').trim() !== '{"schema":1,"profile":"full"}'
    )
      fail('PACKAGED_PROFILE_MARKER_MISMATCH')
  }
  const receiptBytes = readFileSync(candidateReceipt)
  if (receiptBytes.length === 0 || receiptBytes.length > 4 * 1024 * 1024) fail('CANDIDATE_RECEIPT_SIZE')
  let receipt
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'))
  } catch {
    fail('CANDIDATE_RECEIPT_JSON')
  }
  const sourceByDestination = await requiredResourceSources(loose, profile, arch, sourceRoot, root, structuralFixture)
  const deliveredSourceScan = await scanDeliveredSources({
    archive,
    unpackedRoot,
    asar,
    delivered,
    sourceByDestination,
    sourceRoot
  })
  const receiptStatus = await validateReceipt(receipt, {
    build,
    buildSha256: hash(buildBytes),
    profile,
    arch,
    archiveIdentity,
    loose,
    sourceByDestination,
    resourcesRoot: root
  })
  const fontAssets = validateFontAttributions(receipt, delivered, packageLicenses, noticeText, notice, sourceRoot)
  const candidateStatus =
    profile === 'full' && ['win-x64', 'mac-universal'].includes(arch)
      ? 'pre-sign-source-equal default app tree, executable header unsigned; signing-installer-readback-and-owner-acceptance-pending'
      : 'pre-sign-source-equal explicit app tree, executable header unsigned; signing-installer-readback-and-owner-acceptance-pending'
  return {
    schema: 2,
    evidence: structuralFixture ? 'STRUCTURAL_FIXTURE_ONLY' : 'CANDIDATE_APP_TREE_ONLY',
    securityQualification: false,
    sourceCommit: receipt.sourceCommit,
    runId: receipt.runId,
    runAttempt: receipt.runAttempt,
    job: receipt.job,
    runnerOs: receipt.runnerOs,
    profile,
    arch,
    resourcesRoot: root,
    appAsar: archiveIdentity,
    buildEvidence: { bytes: buildBytes.length, sha256: hash(buildBytes), graphSha256: hash(graphBytes) },
    candidateReceipt: { bytes: receiptBytes.length, sha256: hash(receiptBytes) },
    asarEntryCount: asar.length,
    unpackedFileCount: unpacked.filter((entry) => entry.type === 'file' || entry.type === 'link').length,
    looseFileCount: loose.length,
    deliveredFileCount: delivered.length,
    delivered,
    deliveredSourceScan,
    rendererComparedFileCount: expectedIncluded.length,
    rendererProfileExclusions: expectedExcluded.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    packageAndNoticeStatus: 'pinned package notices and complete Apache terms inventoried',
    packageLicenses,
    fullApacheLocation,
    fontAttributionStatus: 'delivered font bytes mapped to verified sources and delivered license material',
    fontAssets,
    receipt: receiptStatus,
    candidateStatus,
    installerReadback: 'UNKNOWN'
  }
}
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const evidence = await inspectCandidate({
    resources: args.get('resources'),
    buildEvidence: args.get('build-evidence'),
    candidateReceipt: args.get('candidate-receipt'),
    katexTarball: args.get('katex-tarball'),
    profile: args.get('profile'),
    arch: args.get('arch')
  })
  writeFileSync(resolve(args.get('out')), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
  console.log('renderer-katex-shipping-evidence:CANDIDATE_APP_TREE_ONLY')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'renderer-katex-shipping-evidence:UNKNOWN')
    process.exitCode = 1
  })
}
