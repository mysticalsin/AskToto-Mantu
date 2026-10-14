#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import { dirname, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MAX_FILES = 100_000
const MAX_TOTAL_BYTES = 10_000_000_000
const SHA256 = /^[a-f0-9]{64}$/
const GIT_SHA = /^[a-f0-9]{40}$/
const SAFE_PATH_PART = /^[A-Za-z0-9._@+-]+$/
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
  return { root: resolve(values.get('--root')), metadata: resolve(values.get('--metadata')), output: resolve(values.get('--output')) }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function validMetadata(value) {
  if (!exactKeys(value, ['schemaVersion', 'kind', 'componentId', 'artifactId', 'target', 'runtime', 'source', 'builder', 'upstream', 'licenses'])) return false
  if (value.schemaVersion !== 1 || !/^[a-z][a-z0-9.-]{0,79}$/.test(value.componentId) || !/^[a-z][a-z0-9.-]{0,79}$/.test(value.artifactId)) return false
  if (!['runtime', 'model'].includes(value.kind)) return false
  if (!exactKeys(value.target, ['platform', 'arch']) || !['darwin', 'win32', 'any'].includes(value.target.platform) || !['arm64', 'x64', 'any'].includes(value.target.arch)) return false
  if ((value.target.platform === 'any') !== (value.target.arch === 'any')) return false
  if (value.runtime !== null) {
    if (!exactKeys(value.runtime, ['electronVersion', 'nodeAbi', 'napi', 'chromiumVersion', 'hostProtocol'])) return false
    if (value.runtime.hostProtocol !== 1 || !/^\d+\.\d+\.\d+$/.test(value.runtime.electronVersion) ||
        !/^\d{1,8}$/.test(value.runtime.nodeAbi) || !/^\d{1,8}$/.test(value.runtime.napi) ||
        !/^\d+\.\d+\.\d+\.\d+$/.test(value.runtime.chromiumVersion)) return false
  }
  if ((value.kind === 'model') !== (value.runtime === null) ||
      (value.kind === 'model') !== (value.target.platform === 'any')) return false
  if (!exactKeys(value.source, ['repositoryUri', 'commit', 'workflowPath', 'workflowCommit', 'runId', 'attempt', 'lockSha256'])) return false
  if (value.source.repositoryUri !== 'https://github.com/mysticalsin/AskToto-Mantu') return false
  if (!GIT_SHA.test(value.source.commit) || !GIT_SHA.test(value.source.workflowCommit) || !SHA256.test(value.source.lockSha256)) return false
  if (!/^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(value.source.workflowPath)) return false
  if (!/^\d{1,20}$/.test(value.source.runId) || !Number.isSafeInteger(value.source.attempt) || value.source.attempt < 1) return false
  if (!exactKeys(value.builder, ['nodeVersion', 'npmVersion', 'zlibVersion', 'packages']) ||
      !/^v\d+\.\d+\.\d+$/.test(value.builder.nodeVersion) || !/^\d+\.\d+\.\d+$/.test(value.builder.npmVersion) ||
      typeof value.builder.zlibVersion !== 'string' || value.builder.zlibVersion.length < 1 ||
      !Array.isArray(value.builder.packages) || value.builder.packages.length < 1 || value.builder.packages.length > 128) return false
  if (value.builder.packages.some((item) => !exactKeys(item, ['name', 'version']) ||
      typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 256 ||
      typeof item.version !== 'string' || item.version.length < 1 || item.version.length > 128)) return false
  if (!Array.isArray(value.upstream) || value.upstream.length < 1 || value.upstream.length > 256) return false
  if (!Array.isArray(value.licenses) || value.licenses.length < 1 || value.licenses.length > 10_000) return false
  return true
}

function safeRelativePath(path) {
  return typeof path === 'string' && path.length <= 1024 && !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && SAFE_PATH_PART.test(part))
}

function validUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}

async function enumeratePayload(root) {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('RUNTIME_PAYLOAD_ROOT_INVALID')
  const rows = []
  const foldedPaths = new Set()
  const seenInodes = new Set()
  let totalBytes = 0

  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const entry of entries) {
      if (!SAFE_PATH_PART.test(entry.name) || entry.name === '.' || entry.name === '..') throw new Error('RUNTIME_PAYLOAD_PATH_INVALID')
      const absolute = resolve(directory, entry.name)
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (!safeRelativePath(path)) throw new Error('RUNTIME_PAYLOAD_PATH_INVALID')
      const folded = path.toLowerCase()
      if (foldedPaths.has(folded)) throw new Error('RUNTIME_PAYLOAD_CASE_COLLISION')
      foldedPaths.add(folded)
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error('RUNTIME_PAYLOAD_LINK_REJECTED')
      if (info.isDirectory()) {
        await walk(absolute, path)
        continue
      }
      if (!info.isFile() || info.nlink !== 1) throw new Error('RUNTIME_PAYLOAD_SPECIAL_OR_HARDLINK_REJECTED')
      if (rows.length >= MAX_FILES || totalBytes + info.size > MAX_TOTAL_BYTES) throw new Error('RUNTIME_PAYLOAD_BOUNDS_EXCEEDED')
      const inode = `${info.dev}:${info.ino}`
      if (seenInodes.has(inode)) throw new Error('RUNTIME_PAYLOAD_HARDLINK_REJECTED')
      seenInodes.add(inode)
      const digest = createHash('sha256')
      let readBytes = 0
      for await (const chunk of createReadStream(absolute)) {
        readBytes += chunk.length
        digest.update(chunk)
      }
      if (readBytes !== info.size) throw new Error('RUNTIME_PAYLOAD_FILE_CHANGED')
      totalBytes += info.size
      const suffix = path.includes('.') ? `.${path.split('.').at(-1).toLowerCase()}` : ''
      rows.push({ path, bytes: info.size, sha256: digest.digest('hex'), executable: (info.mode & 0o111) !== 0 || LOADABLE_SUFFIXES.has(suffix), absolute })
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
    for await (const chunk of createReadStream(row.absolute)) {
      bytes += chunk.length
      digest.update(chunk)
      yield chunk
    }
    if (bytes !== row.bytes || digest.digest('hex') !== row.sha256) throw new Error('RUNTIME_PAYLOAD_FILE_CHANGED')
    const remainder = row.bytes % 512
    if (remainder) yield Buffer.alloc(512 - remainder)
  }
  yield Buffer.alloc(1024)
}

function validateMetadataRecords(metadata, fileMap) {
  const upstream = [...metadata.upstream]
  for (const item of upstream) {
    if (!exactKeys(item, ['name', 'version', 'sourceUri', 'revision', 'digest']) ||
        typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 256 ||
        typeof item.version !== 'string' || item.version.length < 1 || item.version.length > 128 ||
        !validUrl(item.sourceUri) || typeof item.revision !== 'string' || item.revision.length < 1 || item.revision.length > 256 ||
        !exactKeys(item.digest, ['algorithm', 'value']) || !['sha256', 'sha512'].includes(item.digest.algorithm) ||
        !new RegExp(item.digest.algorithm === 'sha256' ? '^[a-f0-9]{64}$' : '^[a-f0-9]{128}$').test(item.digest.value)) {
      throw new Error('RUNTIME_PAYLOAD_UPSTREAM_RECEIPT_INVALID')
    }
  }
  upstream.sort((a, b) => `${a.name}\0${a.version}\0${a.sourceUri}`.localeCompare(`${b.name}\0${b.version}\0${b.sourceUri}`, 'en'))

  const licenses = [...metadata.licenses]
  for (const license of licenses) {
    if (!exactKeys(license, ['package', 'version', 'spdx', 'sourceUri', 'noticePath', 'noticeBytes', 'noticeSha256', 'sourceReceiptUri']) ||
        typeof license.package !== 'string' || license.package.length < 1 || license.package.length > 256 ||
        typeof license.version !== 'string' || license.version.length < 1 || license.version.length > 128 ||
        !/^[A-Za-z0-9.+() -]{1,128}$/.test(license.spdx) || !validUrl(license.sourceUri) || !validUrl(license.sourceReceiptUri) ||
        !safeRelativePath(license.noticePath) || !Number.isSafeInteger(license.noticeBytes) || license.noticeBytes < 1 ||
        !SHA256.test(license.noticeSha256)) throw new Error('RUNTIME_PAYLOAD_LICENSE_RECEIPT_INVALID')
    const notice = fileMap.get(license.noticePath)
    if (!notice || notice.bytes !== license.noticeBytes || notice.sha256 !== license.noticeSha256) {
      throw new Error('RUNTIME_PAYLOAD_LICENSE_FILE_MISMATCH')
    }
  }
  licenses.sort((a, b) => `${a.package}\0${a.version}\0${a.noticePath}`.localeCompare(`${b.package}\0${b.version}\0${b.noticePath}`, 'en'))
  return { upstream, licenses }
}

async function run() {
  const { root, metadata: metadataPath, output } = args(process.argv.slice(2))
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('RUNTIME_PAYLOAD_ACTIONS_ONLY')
  const relativeOutput = relative(root, output)
  if (relativeOutput === '' || (!relativeOutput.startsWith(`..${sep}`) && relativeOutput !== '..')) {
    throw new Error('RUNTIME_PAYLOAD_OUTPUT_INSIDE_INPUT')
  }
  const rawMetadata = await readFile(metadataPath, 'utf8')
  if (Buffer.byteLength(rawMetadata, 'utf8') > 2_000_000) throw new Error('RUNTIME_PAYLOAD_METADATA_OVERSIZED')
  const metadata = JSON.parse(rawMetadata)
  if (!validMetadata(metadata)) throw new Error('RUNTIME_PAYLOAD_METADATA_INVALID')
  const lockBytes = await readFile(new URL('../../package-lock.json', import.meta.url))
  const lockDigest = createHash('sha256').update(lockBytes).digest('hex')
  if (metadata.source.commit !== process.env.GITHUB_SHA || metadata.source.workflowCommit !== process.env.GITHUB_WORKFLOW_SHA ||
      metadata.source.runId !== process.env.GITHUB_RUN_ID || metadata.source.attempt !== Number(process.env.GITHUB_RUN_ATTEMPT) ||
      metadata.source.lockSha256 !== lockDigest || metadata.builder.nodeVersion !== process.version ||
      metadata.builder.zlibVersion !== process.versions.zlib) throw new Error('RUNTIME_PAYLOAD_BUILD_IDENTITY_MISMATCH')
  const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? ''
  const workflowPath = workflowRef.split('/').slice(2).join('/').split('@')[0]
  if (metadata.source.workflowPath !== workflowPath) throw new Error('RUNTIME_PAYLOAD_WORKFLOW_IDENTITY_MISMATCH')
  if (metadata.kind === 'runtime' &&
      (metadata.target.platform !== process.platform || metadata.target.arch !== process.arch)) {
    throw new Error('RUNTIME_PAYLOAD_CROSS_TARGET_BUILD_REJECTED')
  }
  const packageLock = JSON.parse(lockBytes.toString('utf8'))
  const lockedPackages = new Map(Object.entries(packageLock.packages ?? {}).filter(([path]) => path.startsWith('node_modules/'))
    .map(([path, value]) => [path.slice('node_modules/'.length), value.version]))
  const builderPackages = [...metadata.builder.packages]
  const packageKeys = builderPackages.map((item) => item.name)
  if (new Set(packageKeys).size !== packageKeys.length || packageKeys.join('\0') !== [...packageKeys].sort().join('\0') ||
      builderPackages.some((item) => lockedPackages.get(item.name) !== item.version)) {
    throw new Error('RUNTIME_PAYLOAD_BUILDER_LOCK_MISMATCH')
  }
  if (metadata.runtime && metadata.runtime.electronVersion !== lockedPackages.get('electron')) {
    throw new Error('RUNTIME_PAYLOAD_ELECTRON_LOCK_MISMATCH')
  }
  const { rows, totalBytes } = await enumeratePayload(root)
  const fileMap = new Map(rows.map((row) => [row.path, row]))
  const records = validateMetadataRecords(metadata, fileMap)

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

  const inventory = {
    schemaVersion: 1,
    kind: metadata.kind,
    componentId: metadata.componentId,
    artifactId: metadata.artifactId,
    target: metadata.target,
    runtime: metadata.runtime,
    source: metadata.source,
    builder: metadata.builder,
    upstream: records.upstream,
    files: rows.map(({ path, bytes, sha256, executable }) => ({ path, bytes, sha256, executable })),
    licenses: records.licenses
  }
  const inventoryBytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`, 'utf8')
  const inventoryPath = resolve(output, `${metadata.artifactId}.inventory.json`)
  await writeFile(inventoryPath, inventoryBytes, { flag: 'wx', mode: 0o600 })
  const candidate = {
    schemaVersion: 1,
    kind: metadata.kind,
    componentId: metadata.componentId,
    artifactId: metadata.artifactId,
    target: metadata.target,
    runtime: metadata.runtime,
    archive: { path: `${metadata.artifactId}.tar.gz`, bytes: archiveBytes, sha256: gzipHash.digest('hex') },
    inventory: {
      path: `${metadata.artifactId}.inventory.json`,
      bytes: inventoryBytes.length,
      sha256: createHash('sha256').update(inventoryBytes).digest('hex')
    },
    payloadFiles: rows.length,
    payloadBytes: totalBytes
  }
  await writeFile(resolve(output, 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  process.stdout.write(`RUNTIME_PAYLOAD_READY component=${metadata.componentId} target=${metadata.target.platform}-${metadata.target.arch} files=${rows.length} bytes=${totalBytes} archiveSha256=${candidate.archive.sha256}\n`)
}

run().catch((error) => {
  const code = typeof error?.message === 'string' && /^RUNTIME_PAYLOAD_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'RUNTIME_PAYLOAD_BUILD_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
