#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, opendir, readFile, writeFile } from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import { dirname, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Ajv2020 from 'ajv/dist/2020.js'

const MAX_FILES = 100_000
const MAX_DIRECTORIES = 100_000
const MAX_ENTRIES = MAX_FILES + MAX_DIRECTORIES
const MAX_TOTAL_BYTES = 10_000_000_000
const MAX_METADATA_BYTES = 2_000_000
const MAX_INVENTORY_BYTES = 20_000_000
const SHA256 = /^[a-f0-9]{64}$/
const GIT_SHA = /^[a-f0-9]{40}$/
const SAFE_PATH_PART = /^[A-Za-z0-9._@+-]+$/
const ENTRYPOINT_ROLES = new Set([
  'parakeet-host',
  'whisper-import-host',
  'whisper-renderer-worker',
  'speaker-embedding-host',
  'llama-server'
])
const DIRECTORY_ROLES = new Set(['whisper-ort-wasm'])
const MODEL_IDS = new Set([
  'asr.parakeet-tdt-0.6b-v3-int8',
  'asr.whisper-base-q8',
  'speaker.embedding',
  'qwen3.5-0.8b',
  'qwen3.5-4b'
])
const LOADABLE_SUFFIXES = new Set(['.exe', '.dll', '.node', '.dylib', '.so', '.command', '.sh'])

function args(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!['--root', '--metadata', '--output'].includes(key) || values.has(key) || !argv[index + 1]) {
      throw new Error('RUNTIME_PAYLOAD_ARGUMENTS_INVALID')
    }
    values.set(key, argv[index + 1])
    index += 1
  }
  if (values.size !== 3) throw new Error('RUNTIME_PAYLOAD_ARGUMENTS_INVALID')
  return {
    root: resolve(values.get('--root')),
    metadata: resolve(values.get('--metadata')),
    output: resolve(values.get('--output'))
  }
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  )
}

function validMetadata(value) {
  if (
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'componentId',
      'artifactId',
      'target',
      'runtime',
      'entrypoints',
      'directories',
      'models',
      'source',
      'builder',
      'upstream',
      'licenses'
    ])
  )
    return false
  if (
    value.schemaVersion !== 1 ||
    typeof value.componentId !== 'string' ||
    !/^[a-z][a-z0-9.-]{0,79}$/.test(value.componentId) ||
    typeof value.artifactId !== 'string' ||
    !/^[a-z][a-z0-9.-]{0,79}$/.test(value.artifactId)
  )
    return false
  if (!['runtime', 'model'].includes(value.kind)) return false
  if (
    !exactKeys(value.target, ['platform', 'arch']) ||
    !['darwin', 'win32', 'any'].includes(value.target.platform) ||
    !['arm64', 'x64', 'any'].includes(value.target.arch)
  )
    return false
  if ((value.target.platform === 'any') !== (value.target.arch === 'any')) return false
  if (value.runtime !== null) {
    if (!exactKeys(value.runtime, ['electronVersion', 'nodeAbi', 'napi', 'chromiumVersion', 'hostProtocol']))
      return false
    if (
      value.runtime.hostProtocol !== 1 ||
      typeof value.runtime.electronVersion !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(value.runtime.electronVersion) ||
      typeof value.runtime.nodeAbi !== 'string' ||
      !/^\d{1,8}$/.test(value.runtime.nodeAbi) ||
      typeof value.runtime.napi !== 'string' ||
      !/^\d{1,8}$/.test(value.runtime.napi) ||
      typeof value.runtime.chromiumVersion !== 'string' ||
      !/^\d+\.\d+\.\d+\.\d+$/.test(value.runtime.chromiumVersion)
    )
      return false
  }
  if (
    (value.kind === 'model') !== (value.runtime === null) ||
    (value.kind === 'model') !== (value.target.platform === 'any')
  )
    return false
  if (
    !value.entrypoints ||
    typeof value.entrypoints !== 'object' ||
    Array.isArray(value.entrypoints) ||
    Object.keys(value.entrypoints).some((role) => !ENTRYPOINT_ROLES.has(role)) ||
    Object.entries(value.entrypoints).some(([role, path]) => !ENTRYPOINT_ROLES.has(role) || !safeRelativePath(path))
  )
    return false
  if (
    !value.directories ||
    typeof value.directories !== 'object' ||
    Array.isArray(value.directories) ||
    Object.keys(value.directories).some((role) => !DIRECTORY_ROLES.has(role))
  )
    return false
  const directoryMembers = new Set()
  for (const [role, directory] of Object.entries(value.directories)) {
    if (
      !DIRECTORY_ROLES.has(role) ||
      !exactKeys(directory, ['root', 'members']) ||
      !safeRelativePath(directory.root) ||
      !Array.isArray(directory.members) ||
      directory.members.length < 1 ||
      directory.members.length > 1000
    )
      return false
    for (const member of directory.members) {
      if (
        !safeRelativePath(member) ||
        !member.startsWith(`${directory.root}/`) ||
        directoryMembers.has(member.toLowerCase())
      )
        return false
      directoryMembers.add(member.toLowerCase())
    }
  }
  if (
    Object.hasOwn(value.directories, 'whisper-ort-wasm') &&
    (value.kind !== 'runtime' || !Object.hasOwn(value.entrypoints, 'whisper-renderer-worker'))
  )
    return false
  if (!Array.isArray(value.models) || value.models.length > MODEL_IDS.size) return false
  const seenModelIds = new Set()
  const seenModelMembers = new Set()
  for (const model of value.models) {
    if (
      !exactKeys(model, ['id', 'root', 'members']) ||
      !MODEL_IDS.has(model.id) ||
      seenModelIds.has(model.id) ||
      !safeRelativePath(model.root) ||
      !Array.isArray(model.members) ||
      model.members.length < 1 ||
      model.members.length > MAX_FILES
    )
      return false
    seenModelIds.add(model.id)
    for (const member of model.members) {
      if (!safeRelativePath(member) || !member.startsWith(`${model.root}/`) || seenModelMembers.has(member))
        return false
      seenModelMembers.add(member)
    }
  }
  if (
    (value.kind === 'runtime') !== Object.keys(value.entrypoints).length > 0 ||
    (value.kind === 'runtime' && value.models.length !== 0) ||
    (value.kind === 'model' && value.models.length === 0)
  )
    return false
  if (
    !exactKeys(value.source, [
      'repositoryUri',
      'commit',
      'workflowPath',
      'workflowCommit',
      'runId',
      'attempt',
      'lockSha256',
      'ref',
      'runnerEnvironment'
    ])
  )
    return false
  if (value.source.repositoryUri !== 'https://github.com/mysticalsin/AskToto-Mantu') return false
  if (
    typeof value.source.commit !== 'string' ||
    !GIT_SHA.test(value.source.commit) ||
    typeof value.source.workflowCommit !== 'string' ||
    !GIT_SHA.test(value.source.workflowCommit) ||
    typeof value.source.lockSha256 !== 'string' ||
    !SHA256.test(value.source.lockSha256)
  )
    return false
  if (typeof value.source.workflowPath !== 'string') return false
  if (!/^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(value.source.workflowPath)) return false
  if (
    typeof value.source.runId !== 'string' ||
    !/^\d{1,20}$/.test(value.source.runId) ||
    !Number.isSafeInteger(value.source.attempt) ||
    value.source.attempt < 1 ||
    value.source.attempt > 1000
  )
    return false
  if (
    typeof value.source.ref !== 'string' ||
    !/^refs\/(?:heads|pull)\/[A-Za-z0-9._/-]{1,240}$/.test(value.source.ref) ||
    value.source.ref.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    value.source.runnerEnvironment !== 'github-hosted'
  )
    return false
  if (
    !exactKeys(value.builder, ['nodeVersion', 'npmVersion', 'zlibVersion', 'packages']) ||
    typeof value.builder.nodeVersion !== 'string' ||
    !/^v\d+\.\d+\.\d+$/.test(value.builder.nodeVersion) ||
    typeof value.builder.npmVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(value.builder.npmVersion) ||
    typeof value.builder.zlibVersion !== 'string' ||
    value.builder.zlibVersion.length < 1 ||
    value.builder.zlibVersion.length > 64 ||
    !Array.isArray(value.builder.packages) ||
    value.builder.packages.length < 1 ||
    value.builder.packages.length > 128
  )
    return false
  if (
    value.builder.packages.some(
      (item) =>
        !exactKeys(item, ['name', 'version']) ||
        typeof item.name !== 'string' ||
        item.name.length < 1 ||
        item.name.length > 256 ||
        typeof item.version !== 'string' ||
        item.version.length < 1 ||
        item.version.length > 128
    )
  )
    return false
  if (!Array.isArray(value.upstream) || value.upstream.length > 256) return false
  if (!Array.isArray(value.licenses) || value.licenses.length > 10_000) return false
  return true
}

function safeRelativePath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 1024 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    path.split('/').every((part) => {
      if (part === '' || part === '.' || part === '..' || !SAFE_PATH_PART.test(part) || part.endsWith('.')) return false
      const deviceBase = part.split('.')[0]
      return !/^(?:con|prn|aux|nul|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))$/i.test(deviceBase)
    })
  )
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

async function openStableRegularFile(path, errorCode, maxBytes, expectedIdentity) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error(errorCode)
  if (before.size > BigInt(maxBytes)) throw new Error(errorCode)
  if (expectedIdentity && !sameFileIdentity(before, expectedIdentity)) throw new Error('RUNTIME_PAYLOAD_FILE_CHANGED')

  const noFollow = constants.O_NOFOLLOW ?? 0
  const nonBlock = constants.O_NONBLOCK ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlock)
  try {
    const opened = await handle.stat({ bigint: true })
    const afterOpen = await lstat(path, { bigint: true })
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, afterOpen)
    )
      throw new Error(errorCode)
    if (opened.size > BigInt(maxBytes)) throw new Error(errorCode)
    return { handle, identity: opened }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readStableFile(path, maxBytes, errorCode) {
  const { handle, identity } = await openStableRegularFile(path, errorCode, maxBytes)
  try {
    const chunks = []
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
      bytes += chunk.length
      if (bytes > maxBytes) throw new Error(errorCode)
      chunks.push(chunk)
    }
    const afterRead = await handle.stat({ bigint: true })
    const afterPath = await lstat(path, { bigint: true })
    if (
      !sameFileIdentity(identity, afterRead) ||
      !sameFileIdentity(identity, afterPath) ||
      bytes !== Number(identity.size)
    ) {
      throw new Error(errorCode)
    }
    return Buffer.concat(chunks, bytes)
  } finally {
    await handle.close()
  }
}

function validUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

async function enumeratePayload(root) {
  const rootInfo = await lstat(root, { bigint: true })
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('RUNTIME_PAYLOAD_ROOT_INVALID')
  const rows = []
  const foldedPaths = new Set()
  const seenInodes = new Set()
  let totalBytes = 0
  let totalEntries = 0
  let totalDirectories = 0

  async function walk(directory, prefix = '') {
    const beforeDirectory = await lstat(directory, { bigint: true })
    if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink())
      throw new Error('RUNTIME_PAYLOAD_LINK_REJECTED')
    const dir = await opendir(directory)
    const entries = []
    try {
      for await (const entry of dir) {
        totalEntries += 1
        if (totalEntries > MAX_ENTRIES) throw new Error('RUNTIME_PAYLOAD_BOUNDS_EXCEEDED')
        entries.push(entry)
      }
    } finally {
      await dir.close().catch(() => {})
    }
    const afterDirectory = await lstat(directory, { bigint: true })
    if (!sameFileIdentity(beforeDirectory, afterDirectory)) throw new Error('RUNTIME_PAYLOAD_LINK_REJECTED')
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      if (!SAFE_PATH_PART.test(entry.name) || entry.name === '.' || entry.name === '..')
        throw new Error('RUNTIME_PAYLOAD_PATH_INVALID')
      const absolute = resolve(directory, entry.name)
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!safeRelativePath(path)) throw new Error('RUNTIME_PAYLOAD_PATH_INVALID')
      const folded = path.toLowerCase()
      if (foldedPaths.has(folded)) throw new Error('RUNTIME_PAYLOAD_CASE_COLLISION')
      foldedPaths.add(folded)
      const info = await lstat(absolute, { bigint: true })
      if (info.isSymbolicLink()) throw new Error('RUNTIME_PAYLOAD_LINK_REJECTED')
      if (info.isDirectory()) {
        totalDirectories += 1
        if (totalDirectories > MAX_DIRECTORIES) throw new Error('RUNTIME_PAYLOAD_BOUNDS_EXCEEDED')
        await walk(absolute, path)
        continue
      }
      if (!info.isFile() || info.nlink !== 1n) throw new Error('RUNTIME_PAYLOAD_SPECIAL_OR_HARDLINK_REJECTED')
      const size = Number(info.size)
      if (!Number.isSafeInteger(size) || rows.length >= MAX_FILES || totalBytes + size > MAX_TOTAL_BYTES)
        throw new Error('RUNTIME_PAYLOAD_BOUNDS_EXCEEDED')
      const inode = `${info.dev}:${info.ino}`
      if (seenInodes.has(inode)) throw new Error('RUNTIME_PAYLOAD_HARDLINK_REJECTED')
      seenInodes.add(inode)
      const digest = createHash('sha256')
      let readBytes = 0
      const { handle, identity } = await openStableRegularFile(absolute, 'RUNTIME_PAYLOAD_FILE_CHANGED', size, info)
      try {
        for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
          readBytes += chunk.length
          if (readBytes > size) throw new Error('RUNTIME_PAYLOAD_FILE_CHANGED')
          digest.update(chunk)
        }
        const afterRead = await handle.stat({ bigint: true })
        const afterPath = await lstat(absolute, { bigint: true })
        if (!sameFileIdentity(identity, afterRead) || !sameFileIdentity(identity, afterPath) || readBytes !== size) {
          throw new Error('RUNTIME_PAYLOAD_FILE_CHANGED')
        }
      } finally {
        await handle.close()
      }
      totalBytes += size
      const suffix = path.includes('.') ? `.${path.split('.').at(-1).toLowerCase()}` : ''
      rows.push({
        path,
        bytes: size,
        sha256: digest.digest('hex'),
        executable: (info.mode & 0o111n) !== 0n || LOADABLE_SUFFIXES.has(suffix),
        absolute,
        identity
      })
    }
  }

  await walk(root)
  if (rows.length === 0) throw new Error('RUNTIME_PAYLOAD_EMPTY')
  rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  return { rows, totalBytes }
}

function octal(value, width) {
  const encoded = Math.trunc(value).toString(8)
  if (encoded.length > width - 1) throw new Error('RUNTIME_PAYLOAD_TAR_FIELD_OVERFLOW')
  return `${'0'.repeat(width - 1 - encoded.length)}${encoded}\0`
}

function writeString(buffer, value, offset, width) {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length > width) throw new Error('RUNTIME_PAYLOAD_TAR_PATH_OVERFLOW')
  bytes.copy(buffer, offset)
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix }
  }
  throw new Error('RUNTIME_PAYLOAD_TAR_PATH_OVERFLOW')
}

function headerFor(row) {
  const header = Buffer.alloc(512)
  const { name, prefix } = splitUstarPath(row.path)
  writeString(header, name, 0, 100)
  Buffer.from(octal(row.executable ? 0o755 : 0o644, 8)).copy(header, 100)
  Buffer.from(octal(0, 8)).copy(header, 108)
  Buffer.from(octal(0, 8)).copy(header, 116)
  Buffer.from(octal(row.bytes, 12)).copy(header, 124)
  Buffer.from(octal(0, 12)).copy(header, 136)
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeString(header, 'ustar\0', 257, 6)
  writeString(header, '00', 263, 2)
  writeString(header, prefix, 345, 155)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `, 'ascii').copy(header, 148)
  return header
}

async function* tarEntries(rows) {
  for (const row of rows) {
    yield headerFor(row)
    const digest = createHash('sha256')
    let bytes = 0
    const { handle, identity } = await openStableRegularFile(
      row.absolute,
      'RUNTIME_PAYLOAD_FILE_CHANGED',
      row.bytes,
      row.identity
    )
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
        bytes += chunk.length
        if (bytes > row.bytes) throw new Error('RUNTIME_PAYLOAD_FILE_CHANGED')
        digest.update(chunk)
        yield chunk
      }
      const afterRead = await handle.stat({ bigint: true })
      const afterPath = await lstat(row.absolute, { bigint: true })
      if (!sameFileIdentity(identity, afterRead) || !sameFileIdentity(identity, afterPath))
        throw new Error('RUNTIME_PAYLOAD_FILE_CHANGED')
    } finally {
      await handle.close()
    }
    if (bytes !== row.bytes || digest.digest('hex') !== row.sha256) throw new Error('RUNTIME_PAYLOAD_FILE_CHANGED')
    const remainder = row.bytes % 512
    if (remainder) yield Buffer.alloc(512 - remainder)
  }
  yield Buffer.alloc(1024)
}

function validateMetadataRecords(metadata, fileMap) {
  const upstream = [...metadata.upstream]
  if (upstream.length === 0) throw new Error('RUNTIME_PAYLOAD_UPSTREAM_RECEIPT_INVALID')
  for (const item of upstream) {
    if (
      !exactKeys(item, ['name', 'version', 'sourceUri', 'revision', 'digest']) ||
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > 256 ||
      typeof item.version !== 'string' ||
      item.version.length < 1 ||
      item.version.length > 128 ||
      !validUrl(item.sourceUri) ||
      typeof item.revision !== 'string' ||
      item.revision.length < 1 ||
      item.revision.length > 256 ||
      !exactKeys(item.digest, ['algorithm', 'value']) ||
      !['sha256', 'sha512'].includes(item.digest.algorithm) ||
      typeof item.digest.value !== 'string' ||
      !new RegExp(item.digest.algorithm === 'sha256' ? '^[a-f0-9]{64}$' : '^[a-f0-9]{128}$').test(item.digest.value)
    ) {
      throw new Error('RUNTIME_PAYLOAD_UPSTREAM_RECEIPT_INVALID')
    }
  }
  upstream.sort((a, b) =>
    `${a.name}\0${a.version}\0${a.sourceUri}`.localeCompare(`${b.name}\0${b.version}\0${b.sourceUri}`, 'en')
  )

  const licenses = [...metadata.licenses]
  if (licenses.length === 0) throw new Error('RUNTIME_PAYLOAD_LICENSE_RECEIPT_INVALID')
  for (const license of licenses) {
    if (
      !exactKeys(license, [
        'package',
        'version',
        'spdx',
        'sourceUri',
        'noticePath',
        'noticeBytes',
        'noticeSha256',
        'sourceReceiptUri'
      ]) ||
      typeof license.package !== 'string' ||
      license.package.length < 1 ||
      license.package.length > 256 ||
      typeof license.version !== 'string' ||
      license.version.length < 1 ||
      license.version.length > 128 ||
      typeof license.spdx !== 'string' ||
      !/^[A-Za-z0-9.+() -]{1,128}$/.test(license.spdx) ||
      !validUrl(license.sourceUri) ||
      !validUrl(license.sourceReceiptUri) ||
      !safeRelativePath(license.noticePath) ||
      !Number.isSafeInteger(license.noticeBytes) ||
      license.noticeBytes < 1 ||
      license.noticeBytes > 20_000_000 ||
      typeof license.noticeSha256 !== 'string' ||
      !SHA256.test(license.noticeSha256)
    )
      throw new Error('RUNTIME_PAYLOAD_LICENSE_RECEIPT_INVALID')
    const notice = fileMap.get(license.noticePath)
    if (!notice || notice.bytes !== license.noticeBytes || notice.sha256 !== license.noticeSha256) {
      throw new Error('RUNTIME_PAYLOAD_LICENSE_FILE_MISMATCH')
    }
  }
  licenses.sort((a, b) =>
    `${a.package}\0${a.version}\0${a.noticePath}`.localeCompare(`${b.package}\0${b.version}\0${b.noticePath}`, 'en')
  )
  for (const path of Object.values(metadata.entrypoints)) {
    if (!fileMap.has(path)) throw new Error('RUNTIME_PAYLOAD_ENTRYPOINT_FILE_MISSING')
  }
  const directories = Object.fromEntries(
    Object.entries(metadata.directories)
      .map(([role, directory]) => {
        const expected = new Set(directory.members)
        const actual = [...fileMap.keys()].filter((path) => path.startsWith(`${directory.root}/`))
        if (
          fileMap.has(directory.root) ||
          actual.length !== expected.size ||
          actual.some((path) => !expected.has(path)) ||
          directory.members.some((path) => !fileMap.has(path))
        ) {
          throw new Error('RUNTIME_PAYLOAD_DIRECTORY_CLOSURE_MISMATCH')
        }
        return [role, { root: directory.root, members: [...directory.members].sort() }]
      })
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  )
  const models = [...metadata.models]
    .map((model) => {
      for (const path of model.members) {
        if (!fileMap.has(path) || !path.startsWith(`${model.root}/`))
          throw new Error('RUNTIME_PAYLOAD_MODEL_MEMBER_MISSING')
      }
      return { id: model.id, root: model.root, members: [...model.members].sort() }
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const entrypoints = Object.fromEntries(
    Object.entries(metadata.entrypoints).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  )
  return { upstream, licenses, entrypoints, directories, models }
}

async function run() {
  const { root, metadata: metadataPath, output } = args(process.argv.slice(2))
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('RUNTIME_PAYLOAD_ACTIONS_ONLY')
  const relativeOutput = relative(root, output)
  if (relativeOutput === '' || (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== '..')) {
    throw new Error('RUNTIME_PAYLOAD_OUTPUT_INSIDE_INPUT')
  }
  const rawMetadata = await readStableFile(metadataPath, MAX_METADATA_BYTES, 'RUNTIME_PAYLOAD_METADATA_OVERSIZED')
  const metadata = JSON.parse(rawMetadata.toString('utf8'))
  if (!validMetadata(metadata)) throw new Error('RUNTIME_PAYLOAD_METADATA_INVALID')
  const lockBytes = await readFile(new URL('../../package-lock.json', import.meta.url))
  const lockDigest = createHash('sha256').update(lockBytes).digest('hex')
  if (
    metadata.source.commit !== process.env.GITHUB_SHA ||
    metadata.source.workflowCommit !== process.env.GITHUB_WORKFLOW_SHA ||
    metadata.source.runId !== process.env.GITHUB_RUN_ID ||
    metadata.source.attempt !== Number(process.env.GITHUB_RUN_ATTEMPT) ||
    metadata.source.lockSha256 !== lockDigest ||
    metadata.builder.nodeVersion !== process.version ||
    metadata.builder.zlibVersion !== process.versions.zlib
  )
    throw new Error('RUNTIME_PAYLOAD_BUILD_IDENTITY_MISMATCH')
  const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? ''
  const workflowMatch = /^mysticalsin\/AskToto-Mantu\/(\.github\/workflows\/[a-z0-9-]+\.yml)@(.+)$/.exec(workflowRef)
  if (
    !workflowMatch ||
    metadata.source.workflowPath !== workflowMatch[1] ||
    metadata.source.ref !== process.env.GITHUB_REF ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    metadata.source.runnerEnvironment !== process.env.RUNNER_ENVIRONMENT
  ) {
    throw new Error('RUNTIME_PAYLOAD_WORKFLOW_IDENTITY_MISMATCH')
  }
  if (
    metadata.kind === 'runtime' &&
    (metadata.target.platform !== process.platform || metadata.target.arch !== process.arch)
  ) {
    throw new Error('RUNTIME_PAYLOAD_CROSS_TARGET_BUILD_REJECTED')
  }
  const packageLock = JSON.parse(lockBytes.toString('utf8'))
  const lockedPackages = new Map(
    Object.entries(packageLock.packages ?? {})
      .filter(([path]) => path.startsWith('node_modules/'))
      .map(([path, value]) => [path.slice('node_modules/'.length), value.version])
  )
  const builderPackages = [...metadata.builder.packages]
  const packageKeys = builderPackages.map((item) => item.name)
  if (
    new Set(packageKeys).size !== packageKeys.length ||
    packageKeys.join('\0') !== [...packageKeys].sort().join('\0') ||
    builderPackages.some((item) => lockedPackages.get(item.name) !== item.version)
  ) {
    throw new Error('RUNTIME_PAYLOAD_BUILDER_LOCK_MISMATCH')
  }
  if (metadata.runtime && metadata.runtime.electronVersion !== lockedPackages.get('electron')) {
    throw new Error('RUNTIME_PAYLOAD_ELECTRON_LOCK_MISMATCH')
  }
  const { rows, totalBytes } = await enumeratePayload(root)
  const fileMap = new Map(rows.map((row) => [row.path, row]))
  const records = validateMetadataRecords(metadata, fileMap)

  const inventory = {
    schemaVersion: 1,
    kind: metadata.kind,
    componentId: metadata.componentId,
    artifactId: metadata.artifactId,
    target: metadata.target,
    runtime: metadata.runtime,
    entrypoints: records.entrypoints,
    directories: records.directories,
    models: records.models,
    source: metadata.source,
    builder: metadata.builder,
    upstream: records.upstream,
    files: rows.map(({ path, bytes, sha256, executable }) => ({ path, bytes, sha256, executable })),
    licenses: records.licenses
  }
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
  if (inventoryBytes.length > MAX_INVENTORY_BYTES) throw new Error('RUNTIME_PAYLOAD_INVENTORY_OVERSIZED')
  const inventorySchema = JSON.parse(
    await readFile(new URL('../../resources/runtime-schema/inventory.schema.json', import.meta.url), 'utf8')
  )
  const validateInventory = new Ajv2020({ allErrors: true, strict: false }).compile(inventorySchema)
  if (!validateInventory(inventory)) throw new Error('RUNTIME_PAYLOAD_INVENTORY_SCHEMA_MISMATCH')

  await mkdir(output, { recursive: true })
  const archivePath = resolve(output, `${metadata.artifactId}.tar.gz`)
  const gzipHash = createHash('sha256')
  let archiveBytes = 0
  const hashAndCount = new Transform({
    transform(chunk, _encoding, callback) {
      archiveBytes += chunk.length
      gzipHash.update(chunk)
      callback(null, chunk)
    }
  })
  await pipeline(
    (await import('node:stream')).Readable.from(tarEntries(rows)),
    createGzip({ level: 9, mtime: 0 }),
    hashAndCount,
    createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
  )

  const inventoryPath = resolve(output, `${metadata.artifactId}.inventory.json`)
  await writeFile(inventoryPath, inventoryBytes, { flag: 'wx', mode: 0o600 })
  const candidate = {
    schemaVersion: 1,
    kind: metadata.kind,
    componentId: metadata.componentId,
    artifactId: metadata.artifactId,
    target: metadata.target,
    runtime: metadata.runtime,
    directories: records.directories,
    archive: { path: `${metadata.artifactId}.tar.gz`, bytes: archiveBytes, sha256: gzipHash.digest('hex') },
    inventory: {
      path: `${metadata.artifactId}.inventory.json`,
      bytes: inventoryBytes.length,
      sha256: createHash('sha256').update(inventoryBytes).digest('hex')
    },
    payloadFiles: rows.length,
    payloadBytes: totalBytes
  }
  await writeFile(resolve(output, 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600
  })
  process.stdout.write(
    `RUNTIME_PAYLOAD_READY component=${metadata.componentId} target=${metadata.target.platform}-${metadata.target.arch} files=${rows.length} bytes=${totalBytes} archiveSha256=${candidate.archive.sha256}\n`
  )
}

run().catch((error) => {
  const code =
    typeof error?.message === 'string' && /^RUNTIME_PAYLOAD_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'RUNTIME_PAYLOAD_BUILD_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
