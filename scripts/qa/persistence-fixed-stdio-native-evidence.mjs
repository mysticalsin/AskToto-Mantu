import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'

const BASE = 'ff7a13314208a7f8c6a6c9d0c73e4fd286fa3fa3'
const SCHEMA = 'metis-fixed-stdio-native/v1'
const ENTRY = 'scripts/qa/persistence-fixed-stdio-native.mjs'
const WORKFLOW = '.github/workflows/qa-fixed-stdio-native.yml'
const CHILD = 'scripts/qa/persistence-fixed-stdio-native-child.mjs'
const EVIDENCE = 'scripts/qa/persistence-fixed-stdio-native-evidence.mjs'
const REPLAY = 'scripts/qa/persistence-fixed-stdio-native-replay.mjs'
const SOURCES = [ENTRY, CHILD, EVIDENCE, REPLAY, WORKFLOW]
const IDS = ['N01', 'N02', 'N03', 'N04', 'N05', 'N06']
const NAMES = [
  'fs-silent-peer-destroy',
  'socket-silent-peer-destroy',
  'fs-output-peer-close',
  'socket-output-peer-close',
  'fs-pending-write-destroy',
  'socket-pending-write-destroy'
]
const SOCKET = new Set(['N02', 'N04', 'N06'])
const BULK = new Set(['N05', 'N06'])
const OP = new Set([
  'acquire',
  'goal',
  'api-write',
  'fs-read',
  'fs-write',
  'fs-writev',
  'fs-close',
  'socket-read',
  'stream-end',
  'stream-error',
  'stream-close',
  'fd-check',
  'local-destroy',
  'peer-read',
  'peer-pause',
  'peer-resume',
  'peer-end',
  'peer-destroy',
  'peer-close',
  'spawn',
  'ipc-send',
  'ipc-disconnect',
  'frontier-fsync',
  'infra-term',
  'fatal',
  'drain-expiry',
  'case-release'
])
const PHASE = new Set(['setup', 'goal', 'rescue', 'finish'])
const STATES = new Set(['start', 'fulfilled', 'rejected', 'observed', 'requested', 'threw'])
const OUTCOMES = new Set([
  'OBSERVED_GOAL',
  'PENDING_AT_SAMPLE',
  'API_ACQUISITION_REJECTED',
  'PREREQUISITE_UNREACHED',
  'OBSERVED_ERROR',
  'INCOMPLETE_INFRA'
])
const TARGETS = {
  'linux-x64': ['linux', 'x64'],
  'win32-x64': ['win32', 'x64'],
  'darwin-arm64': ['darwin', 'arm64'],
  'darwin-x64': ['darwin', 'x64']
}
const MAX_TOTAL = 4 * 1024 * 1024
const MAX_META = 128 * 1024
const MAX_CASE = 256 * 1024
const MAX_STDERR = 16 * 1024
const MAX_PEER_OUT = 524289
const MAX_PAYLOAD = 2048
const MAX_ENVELOPE = 4096
const EXIT_RESERVE = 2 * MAX_META
const encoder = new TextEncoder()

function assert(ok, message) {
  if (!ok) throw new Error(message)
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function digestText(value) {
  return hash(encoder.encode(value))
}

function digestLongText(value) {
  const h = crypto.createHash('sha256')
  for (let offset = 0; offset < value.length; ) {
    let end = Math.min(value.length, offset + 4096)
    if (end < value.length && value.charCodeAt(end - 1) >= 0xd800 && value.charCodeAt(end - 1) <= 0xdbff) end--
    h.update(value.slice(offset, end), 'utf8')
    offset = end
  }
  return h.digest('hex')
}

// Count canonical JSON without first allocating its encoded representation.
function jsonBytes(value, limit) {
  let count = 0
  const add = (n) => {
    count += n
    assert(count <= limit, 'canonical JSON byte budget')
  }
  const string = (input) => {
    add(2)
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i)
      if (code === 34 || code === 92) add(2)
      else if (code <= 31) add(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6)
      else if (code < 128) add(1)
      else if (code < 2048) add(2)
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
        const next = input.charCodeAt(i + 1)
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(4)
          i++
        } else add(6)
      } else if (code >= 0xd800 && code <= 0xdfff) add(6)
      else add(3)
    }
  }
  const visit = (item) => {
    if (item === null) return add(4)
    if (typeof item === 'boolean') return add(item ? 4 : 5)
    if (typeof item === 'string') return string(item)
    if (typeof item === 'number') {
      assert(Number.isFinite(item), 'finite JSON number')
      return add(String(item).length)
    }
    if (Array.isArray(item)) {
      add(2)
      item.forEach((entry, index) => {
        if (index) add(1)
        visit(entry)
      })
      return
    }
    assert(item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype, 'plain JSON object')
    add(2)
    Object.keys(item).forEach((key, index) => {
      if (index) add(1)
      string(key)
      add(1)
      visit(item[key])
    })
  }
  visit(value)
  return count
}

function boundedJson(value, limit) {
  const size = jsonBytes(value, limit - 1)
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  assert(bytes.length === size + 1 && bytes.length <= limit, 'canonical JSON size agreement')
  return bytes
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), label + ' must be an object')
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  assert(actual.length === expected.length && actual.every((key, i) => key === expected[i]), label + ' keys')
}

function errorProjection(error) {
  const take = (value) => {
    if (value == null) return null
    assert(typeof value === 'string' && value.length <= 64 && Buffer.byteLength(value) <= 64, 'error field bound')
    return value
  }
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return {
    name: take(error?.name),
    code: take(error?.code),
    syscall: take(error?.syscall),
    errno: Number.isSafeInteger(error?.errno) ? error.errno : null,
    messageSha256: digestLongText(message)
  }
}

function stickyFailure(state, error) {
  if (!state.hasPrimaryFailure) {
    state.hasPrimaryFailure = true
    state.primaryFailure = error
  } else if (state.secondaryFailures.length < 256) state.secondaryFailures.push(error)
  if (!state.hasSticky) {
    state.hasSticky = true
    state.sticky = error
  }
}

function safeRuntime() {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    versions: { v8: process.versions.v8, modules: process.versions.modules, uv: process.versions.uv }
  }
}

function readBounded(file, limit) {
  const before = fs.lstatSync(file)
  assert(before.isFile() && !before.isSymbolicLink(), 'bounded regular file required')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let hasPrimary = false
  let primary
  let result
  try {
    const held = fs.fstatSync(fd)
    assert(sameFile(before, held) && held.size <= limit, 'held file identity/size')
    result = readAllHeld(fd, held.size, limit, held)
  } catch (error) {
    hasPrimary = true
    primary = error
  }
  try {
    fs.closeSync(fd)
  } catch (error) {
    if (hasPrimary) throw new AggregateError([primary, error], 'bounded read and close failed')
    throw error
  }
  if (hasPrimary) throw primary
  return result
}

function sameFile(a, b) {
  return (
    (typeof a.isFile !== 'function' || a.isFile()) &&
    b.isFile() &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size
  )
}

function heldEpoch(stat) {
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'held regular single-link file')
  assert(
    typeof stat.dev === 'bigint' &&
      typeof stat.ino === 'bigint' &&
      typeof stat.size === 'bigint' &&
      typeof stat.mtimeNs === 'bigint' &&
      typeof stat.ctimeNs === 'bigint',
    'held BigInt identity and version'
  )
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs]
}

function sameHeldEpoch(before, after) {
  const left = heldEpoch(before)
  const right = heldEpoch(after)
  return left.every((value, index) => value === right[index])
}

function writeAll(fd, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, null)
    assert(written > 0, 'short write made no progress')
    offset += written
  }
}

function readAllHeld(fd, expectedSize, limit, original = null) {
  assert(Number.isSafeInteger(expectedSize) && expectedSize >= 0 && expectedSize <= limit, 'readback bound')
  const stat = fs.fstatSync(fd, { bigint: true })
  heldEpoch(stat)
  assert(stat.size === BigInt(expectedSize), 'held descriptor size changed')
  if (original)
    assert(stat.dev === BigInt(original.dev) && stat.ino === BigInt(original.ino), 'held descriptor owner changed')
  const output = Buffer.alloc(expectedSize)
  let offset = 0
  while (offset < expectedSize) {
    const count = fs.readSync(fd, output, offset, expectedSize - offset, offset)
    assert(count > 0, 'held readback ended early')
    offset += count
  }
  assert(sameHeldEpoch(stat, fs.fstatSync(fd, { bigint: true })), 'held descriptor changed during read')
  return output
}

function readHeldPrefix(fd, size, limit, original) {
  const before = fs.fstatSync(fd, { bigint: true })
  heldEpoch(before)
  assert(
    before.dev === original.dev &&
      before.ino === original.ino &&
      Number.isSafeInteger(size) &&
      size >= 0 &&
      BigInt(size) <= before.size &&
      before.size <= BigInt(limit) &&
      size <= limit,
    'held prefix identity/bound'
  )
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = fs.readSync(fd, bytes, offset, size - offset, offset)
    assert(count > 0, 'held prefix progress')
    offset += count
  }
  const after = fs.fstatSync(fd, { bigint: true })
  assert(sameHeldEpoch(before, after), 'held prefix version changed')
  return bytes
}

function sourceCommand(args, outputLimit) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: null,
    timeout: 5000,
    maxBuffer: outputLimit,
    windowsHide: true,
    shell: false
  })
  assert(!result.error, 'Git source fence failed: ' + String(result.error))
  assert(result.status === 0, 'Git source fence returned ' + String(result.status))
  assert(!result.signal, 'Git source fence was signalled')
  assert(result.stdout.length <= outputLimit && result.stderr.length <= 64 * 1024, 'Git output bound')
  return result.stdout
}

async function hashExecutable(file) {
  const before = fs.lstatSync(file)
  assert(before.isFile() && !before.isSymbolicLink(), 'Node executable identity')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let hasPrimary = false
  let primary
  let digest
  try {
    const stat = fs.fstatSync(fd)
    assert(sameFile(before, stat) && stat.size > 0 && stat.size <= 256 * 1024 * 1024, 'Node executable size')
    const h = crypto.createHash('sha256')
    let total = 0
    const buffer = Buffer.alloc(64 * 1024)
    while (total < stat.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - total), total)
      assert(count > 0, 'Node executable read progress')
      h.update(buffer.subarray(0, count))
      total += count
    }
    assert(sameFile(stat, fs.fstatSync(fd)), 'Node executable changed while hashing')
    digest = h.digest('hex')
  } catch (error) {
    hasPrimary = true
    primary = error
  }
  try {
    fs.closeSync(fd)
  } catch (error) {
    if (hasPrimary) throw new AggregateError([primary, error], 'executable read and close failed')
    throw error
  }
  if (hasPrimary) throw primary
  return digest
}

function provenance() {
  const runId = process.env.GITHUB_RUN_ID
  const attempt = process.env.GITHUB_RUN_ATTEMPT
  const job = process.env.GITHUB_JOB
  const target = process.env.METIS_N0_TARGET
  const workflowRef = process.env.GITHUB_WORKFLOW_REF
  const ref = process.env.GITHUB_REF
  assert(/^[0-9]{1,20}$/.test(runId || ''), 'run id missing')
  assert(/^[0-9]{1,8}$/.test(attempt || ''), 'run attempt missing')
  assert(job === 'fixed-stdio', 'job identity')
  assert(Object.hasOwn(TARGETS, target), 'target identity')
  assert(ref === 'refs/heads/fix/qa-fixed-stdio-native', 'branch ref')
  assert(
    typeof workflowRef === 'string' && workflowRef.endsWith('/' + WORKFLOW + '@' + ref) && workflowRef.length <= 256,
    'workflow file ref'
  )
  assert(process.env.GITHUB_SHA, 'GITHUB_SHA missing')
  if (process.env.GITHUB_WORKFLOW_SHA)
    assert(process.env.GITHUB_WORKFLOW_SHA === process.env.GITHUB_SHA, 'workflow SHA mismatch')
  const expected = TARGETS[target]
  const runtime = safeRuntime()
  assert(runtime.nodeVersion === 'v22.22.3', 'Node version mismatch')
  assert(runtime.platform === expected[0] && runtime.arch === expected[1], 'target runtime mismatch')
  return { runId, attempt, job, target, ref, workflowRef, runtime }
}

function sourceFence(meta) {
  const head = sourceCommand(['rev-parse', 'HEAD'], 64 * 1024)
    .toString('utf8')
    .trim()
  assert(/^[0-9a-f]{40}$/.test(head) && head === process.env.GITHUB_SHA, 'HEAD/GITHUB_SHA mismatch')
  const branch = sourceCommand(['branch', '--show-current'], 64 * 1024)
    .toString('utf8')
    .trim()
  assert(branch === 'fix/qa-fixed-stdio-native', 'branch mismatch')
  const dirty = sourceCommand(['status', '--porcelain=v1', '--untracked-files=all'], 64 * 1024)
  assert(dirty.length === 0, 'checkout is dirty')
  const changes = sourceCommand(['diff', '--name-status', '--no-renames', BASE, 'HEAD'], 64 * 1024)
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
  const expectedChanges = SOURCES.map((file) => 'A\t' + file).sort()
  assert(
    changes.length === expectedChanges.length && changes.every((line, i) => line === expectedChanges[i]),
    'base diff is not the five authorized additions'
  )
  const treeLines = sourceCommand(['ls-tree', '-r', '--full-tree', 'HEAD', '--', ...SOURCES], 64 * 1024)
    .toString('utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
  assert(treeLines.length === SOURCES.length, 'source tree roster')
  const tree = new Map()
  for (const line of treeLines) {
    const match = /^(100644) blob ([0-9a-f]{40})\t(.+)$/.exec(line)
    assert(match, 'source tree entry shape')
    tree.set(match[3], match[2])
  }
  const files = []
  for (const file of SOURCES) {
    const blob = sourceCommand(['show', 'HEAD:' + file], 256 * 1024)
    assert(blob.length <= 256 * 1024 && tree.has(file), 'source blob bound or missing')
    const checkoutPath = path.join(process.cwd(), file)
    const checkout = readBounded(checkoutPath, 256 * 1024)
    let projection = 'identical'
    let expectedBytes = blob
    if (!checkout.equals(blob) && process.platform === 'win32' && !blob.includes(13)) {
      expectedBytes = Buffer.from(new TextDecoder('utf-8', { fatal: true }).decode(blob).replace(/\n/g, '\r\n'), 'utf8')
      projection = 'git-lf-to-checkout-crlf'
    }
    assert(checkout.equals(expectedBytes), 'checkout bytes differ from Git blob projection: ' + file)
    files.push({
      path: file,
      blobId: tree.get(file),
      gitSha256: hash(blob),
      checkoutSha256: hash(checkout),
      projection,
      bytes: blob.length
    })
  }
  const sourceSetSha256 = hash(Buffer.from(JSON.stringify(files)))
  return {
    head,
    branch,
    base: BASE,
    files,
    sourceSetSha256,
    runtime: meta.runtime,
    execPath: process.execPath
  }
}

function runnerDirectory(meta) {
  const temp = process.env.RUNNER_TEMP
  assert(
    typeof temp === 'string' &&
      path.isAbsolute(temp) &&
      !/[\x00-\x1f\x7f]/.test(temp) &&
      temp.length <= 2048 &&
      Buffer.byteLength(temp) <= 2048,
    'RUNNER_TEMP absolute Unicode bound'
  )
  assert(Buffer.from(temp, 'utf8').toString('utf8') === temp, 'RUNNER_TEMP canonical Unicode')
  const resolved = path.resolve(temp)
  const parts = []
  for (let current = resolved; ; current = path.dirname(current)) {
    parts.unshift(current)
    assert(parts.length <= 32, 'RUNNER_TEMP ancestor bound')
    if (path.dirname(current) === current) break
  }
  for (const component of parts) {
    const stat = fs.lstatSync(component, { bigint: true })
    assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.ino > 0n, 'RUNNER_TEMP ancestor identity')
  }
  return path.join(resolved, 'metis-fixed-stdio-native-' + meta.runId + '-' + meta.attempt + '-' + meta.target)
}

const MAX_CUSTODY = 16384
const MAX_OUTPUT = 24576
const U64 = 18446744073709551615n
function dirId(stat) {
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'directory type')
  assert(stat.dev >= 0n && stat.dev <= U64 && stat.ino > 0n && stat.ino <= U64, 'directory identity')
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function ancestorPaths(runnerTemp) {
  const paths = []
  for (let current = runnerTemp; ; current = path.dirname(current)) {
    paths.unshift(current)
    assert(paths.length <= 32, 'ancestor count')
    if (path.dirname(current) === current) break
  }
  return paths
}

function bindingFor(meta, source) {
  return {
    head: source.head,
    runId: meta.runId,
    attempt: meta.attempt,
    job: meta.job,
    target: meta.target,
    sourceSetSha256: source.sourceSetSha256
  }
}

function captureRoot(directory) {
  const runnerTemp = path.resolve(process.env.RUNNER_TEMP)
  assert(path.dirname(directory) === runnerTemp, 'evidence parent')
  const ancestors = ancestorPaths(runnerTemp).map((component) => dirId(fs.lstatSync(component, { bigint: true })))
  const root = dirId(fs.lstatSync(directory, { bigint: true }))
  return { runnerTemp, ancestors, basename: path.basename(directory), dev: root.dev, ino: root.ino }
}

function guardRoot(directory, root) {
  exactKeys(root, ['runnerTemp', 'ancestors', 'basename', 'dev', 'ino'], 'custody root')
  assert(root.runnerTemp === path.resolve(process.env.RUNNER_TEMP), 'custody runner parent')
  assert(path.dirname(directory) === root.runnerTemp && path.basename(directory) === root.basename, 'custody name')
  const paths = ancestorPaths(root.runnerTemp)
  assert(Array.isArray(root.ancestors) && root.ancestors.length === paths.length, 'custody ancestor count')
  for (let i = 0; i < paths.length; i++) {
    exactKeys(root.ancestors[i], ['dev', 'ino'], 'ancestor ID')
    assert(
      JSON.stringify(dirId(fs.lstatSync(paths[i], { bigint: true }))) === JSON.stringify(root.ancestors[i]),
      'ancestor changed'
    )
  }
  const actual = dirId(fs.lstatSync(directory, { bigint: true }))
  assert(actual.dev === root.dev && actual.ino === root.ino, 'evidence root changed')
}

function fileIdentity(stat, name) {
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'single-link regular artifact')
  assert(stat.dev >= 0n && stat.dev <= U64 && stat.ino > 0n && stat.ino <= U64, 'artifact identity')
  assert(stat.size >= 0n && stat.size <= BigInt(artifactLimit(name)), 'artifact limit')
  return { name, dev: String(stat.dev), ino: String(stat.ino) }
}

function closedFile(stat, name, sha256) {
  const identity = fileIdentity(stat, name)
  assert(
    stat.mtimeNs >= -(1n << 63n) &&
      stat.mtimeNs < 1n << 63n &&
      stat.ctimeNs >= -(1n << 63n) &&
      stat.ctimeNs < 1n << 63n &&
      typeof sha256 === 'string' &&
      /^[0-9a-f]{64}$/.test(sha256),
    'closed artifact version'
  )
  return {
    ...identity,
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    sha256
  }
}

function guardFile(directory, root, row, expectedName) {
  guardRoot(directory, root)
  assert(row.name === expectedName, 'custody artifact roster')
  const actual = fileIdentity(fs.lstatSync(path.join(directory, expectedName), { bigint: true }), expectedName)
  assert(actual.dev === row.dev && actual.ino === row.ino, 'published artifact changed')
  return actual
}

function guardClosedVersion(directory, custody, row) {
  guardFile(directory, custody.root, row, row.name)
  assert(
    JSON.stringify(closedFile(fs.lstatSync(path.join(directory, row.name), { bigint: true }), row.name, row.sha256)) ===
      JSON.stringify(row),
    'closed artifact version changed'
  )
}

function custodyText(custody) {
  jsonBytes(custody, MAX_CUSTODY)
  const wire = JSON.stringify(custody)
  assert(Buffer.byteLength(wire) <= MAX_CUSTODY, 'custody wire bound')
  return Buffer.from(wire).toString('base64')
}

function parseCustody(encoded, directory, meta, phase, source = null) {
  assert(
    typeof encoded === 'string' &&
      encoded.length <= 21848 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),
    'custody base64'
  )
  const decoded = Buffer.from(encoded, 'base64')
  assert(decoded.length <= MAX_CUSTODY && decoded.toString('base64') === encoded, 'canonical custody base64')
  const wire = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  const value = JSON.parse(wire)
  assert(JSON.stringify(value) === wire, 'canonical custody JSON')
  const acquired = phase === 'acquired'
  exactKeys(value, acquired ? ['v', 'binding', 'root', 'files'] : ['v', 'phase', 'binding', 'root', 'files'], 'custody')
  assert(value.v === 1 && (acquired || value.phase === phase), 'custody phase')
  exactKeys(value.binding, ['head', 'runId', 'attempt', 'job', 'target', 'sourceSetSha256'], 'custody binding')
  assert(
    value.binding.head === process.env.GITHUB_SHA &&
      value.binding.runId === meta.runId &&
      value.binding.attempt === meta.attempt &&
      value.binding.job === meta.job &&
      value.binding.target === meta.target &&
      /^[0-9a-f]{64}$/.test(value.binding.sourceSetSha256),
    'custody source/run binding'
  )
  if (source)
    assert(JSON.stringify(value.binding) === JSON.stringify(bindingFor(meta, source)), 'custody source mismatch')
  guardRoot(directory, value.root)
  const length = { acquired: 26, collector: 26, exit: 27, replay: 28 }[phase]
  assert(Array.isArray(value.files) && value.files.length === length, 'custody file count')
  const identities = new Set()
  value.files.forEach((row, index) => {
    exactKeys(
      row,
      acquired ? ['name', 'dev', 'ino'] : ['name', 'dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'sha256'],
      'custody file'
    )
    const name = ARTIFACTS[index]
    guardFile(directory, value.root, row, name)
    const key = row.dev + ':' + row.ino
    assert(!identities.has(key), 'duplicate artifact identity')
    identities.add(key)
    if (!acquired) {
      assert(
        Number.isSafeInteger(row.size) &&
          row.size >= 0 &&
          row.size <= artifactLimit(name) &&
          /^-?(?:0|[1-9][0-9]{0,18})$/.test(row.mtimeNs) &&
          row.mtimeNs !== '-0' &&
          /^-?(?:0|[1-9][0-9]{0,18})$/.test(row.ctimeNs) &&
          row.ctimeNs !== '-0' &&
          typeof row.sha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(row.sha256),
        'custody closed version shape'
      )
      guardClosedVersion(directory, value, row)
    }
  })
  return value
}

function readCustodyFile(directory, custody, name) {
  const row = custody.files[ARTIFACTS.indexOf(name)]
  assert(row && row.name === name && Object.hasOwn(row, 'sha256'), 'closed custody input')
  guardFile(directory, custody.root, row, name)
  const file = path.join(directory, name)
  const before = closedFile(fs.lstatSync(file, { bigint: true }), name, row.sha256)
  assert(JSON.stringify(before) === JSON.stringify(row), 'artifact version before read')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  let hasPrimary = false
  let primary
  let bytes
  try {
    const held = closedFile(fs.fstatSync(fd, { bigint: true }), name, row.sha256)
    assert(JSON.stringify(held) === JSON.stringify(row), 'held artifact version')
    bytes = readAllHeld(fd, row.size, artifactLimit(name))
    assert(hash(bytes) === row.sha256, 'held artifact digest')
    assert(
      JSON.stringify(closedFile(fs.fstatSync(fd, { bigint: true }), name, row.sha256)) === JSON.stringify(row),
      'artifact version after read'
    )
  } catch (error) {
    hasPrimary = true
    primary = error
  }
  try {
    fs.closeSync(fd)
  } catch (error) {
    if (hasPrimary) throw new AggregateError([primary, error], 'artifact read and close failed')
    throw error
  }
  if (hasPrimary) throw primary
  guardFile(directory, custody.root, row, name)
  assert(
    JSON.stringify(closedFile(fs.lstatSync(file, { bigint: true }), name, row.sha256)) === JSON.stringify(row),
    'artifact version after close'
  )
  return bytes
}

const namesFor = (id) => [
  id + '.events.ndjson',
  id + '.peer-input.bin',
  id + '.peer-output.bin',
  id + '.stderr.raw.log'
]

function artifactLimit(name) {
  if (!ARTIFACTS.includes(name)) throw new Error('unknown artifact name: ' + name)
  if (['collector.json', 'parent.events.ndjson', 'collector-exit.json', 'replay.json'].includes(name)) return MAX_META
  if (name.endsWith('.events.ndjson')) return MAX_CASE
  if (name.endsWith('.peer-input.bin')) return 1
  if (name.endsWith('.peer-output.bin')) return BULK.has(name.slice(0, 3)) ? MAX_PEER_OUT : 1
  if (name.endsWith('.stderr.raw.log')) return MAX_STDERR
  return MAX_META
}

const ARTIFACTS = [
  ...IDS.flatMap(namesFor),
  'collector.json',
  'parent.events.ndjson',
  'collector-exit.json',
  'replay.json'
]

function closeArtifactRegistry(registry) {
  for (const handle of registry.handles.values()) {
    if (handle.closeAttempted) continue
    try {
      handle.closeAttempted = true
      fs.closeSync(handle.fd)
      handle.closed = true
    } catch (error) {
      registry.failures.push(error)
    }
  }
  return registry.failures
}

function createArtifacts(directory, meta, registry) {
  assert(registry && registry.handles instanceof Map && Array.isArray(registry.failures), 'installed owner registry')
  fs.mkdirSync(directory, { mode: 0o700 })
  const root = captureRoot(directory)
  registry.root = root
  registry.directory = directory
  const handles = registry.handles
  const sizes = new Map()
  const hashes = new Map()
  const failures = registry.failures
  let total = 0
  const roster = ARTIFACTS.filter((name) => !['collector-exit.json', 'replay.json'].includes(name))
  try {
    for (const name of roster) {
      guardRoot(directory, root)
      const fd = fs.openSync(path.join(directory, name), 'wx+', 0o600)
      const handle = { fd, stat: null, closed: false, closeAttempted: false, sealed: false, closedFile: null }
      handles.set(name, handle)
      handle.stat = fs.fstatSync(fd, { bigint: true })
      fileIdentity(handle.stat, name)
      guardFile(directory, root, handle.stat && fileIdentity(handle.stat, name), name)
      sizes.set(name, 0)
    }
  } catch (error) {
    failures.push(error)
    closeArtifactRegistry(registry)
    throw failures.length === 1 ? error : new AggregateError(failures, 'artifact acquisition cleanup')
  }

  function append(name, bytes) {
    const handle = handles.get(name)
    assert(handle && !handle.closeAttempted, 'artifact is not held: ' + name)
    guardFile(directory, root, fileIdentity(handle.stat, name), name)
    assert(Buffer.isBuffer(bytes) || typeof bytes === 'string', 'artifact byte input')
    const incoming = Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes)
    assert(incoming <= artifactLimit(name) - sizes.get(name), 'artifact preallocation budget')
    assert(total + incoming + EXIT_RESERVE <= MAX_TOTAL, 'artifact global preallocation budget')
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const next = sizes.get(name) + buffer.length
    assert(next <= artifactLimit(name), 'artifact file limit: ' + name)
    assert(total + buffer.length + EXIT_RESERVE <= MAX_TOTAL, 'artifact total limit')
    let offset = 0
    try {
      while (offset < buffer.length) {
        const written = fs.writeSync(handle.fd, buffer, offset, buffer.length - offset, null)
        assert(written > 0, 'artifact write made no progress')
        offset += written
        sizes.set(name, sizes.get(name) + written)
        total += written
      }
      guardFile(directory, root, fileIdentity(handle.stat, name), name)
    } catch (error) {
      failures.push(error)
      throw error
    }
  }

  function closeAndHash(name) {
    const handle = handles.get(name)
    if (!handle || handle.closeAttempted) return hashes.get(name)
    const size = sizes.get(name)
    let hasPrimary = false
    let primary
    let digest = null
    try {
      guardFile(directory, root, fileIdentity(handle.stat, name), name)
      const bytes = readAllHeld(handle.fd, size, artifactLimit(name))
      digest = hash(bytes)
      fs.fsyncSync(handle.fd)
      const held = fs.fstatSync(handle.fd, { bigint: true })
      assert(
        held.dev === handle.stat.dev && held.ino === handle.stat.ino && held.size === BigInt(size),
        'artifact changed before close'
      )
    } catch (error) {
      hasPrimary = true
      primary = error
      failures.push(error)
    }
    try {
      handle.closeAttempted = true
      fs.closeSync(handle.fd)
      handle.closed = true
    } catch (error) {
      failures.push(error)
      if (hasPrimary) throw new AggregateError([primary, error], 'artifact seal and close failed')
      throw error
    }
    if (hasPrimary) throw primary
    const stat = fs.lstatSync(path.join(directory, name), { bigint: true })
    const record = closedFile(stat, name, digest)
    assert(
      record.dev === String(handle.stat.dev) && record.ino === String(handle.stat.ino) && record.size === size,
      'artifact publication changed'
    )
    guardFile(directory, root, record, name)
    handle.closedFile = record
    handle.sealed = true
    hashes.set(name, digest)
    return digest
  }

  function closeAll() {
    const results = {}
    for (const name of [...handles.keys()]) {
      try {
        results[name] = closeAndHash(name)
      } catch (error) {
        failures.push(error)
      }
    }
    return results
  }

  return {
    directory,
    root,
    meta,
    handles,
    sizes,
    hashes,
    failures,
    append,
    closeAndHash,
    closeAll,
    roster,
    get total() {
      return total
    }
  }
}

function acquiredCustody(artifacts, source) {
  assert(artifacts.roster.length === 26, 'acquired roster')
  const files = artifacts.roster.map((name) => {
    const handle = artifacts.handles.get(name)
    assert(handle && !handle.closeAttempted, 'acquired owner')
    const row = fileIdentity(handle.stat, name)
    guardFile(artifacts.directory, artifacts.root, row, name)
    return row
  })
  return { v: 1, binding: bindingFor(artifacts.meta, source), root: artifacts.root, files }
}

function closedCustody(artifacts, acquisition, phase = 'collector') {
  assert(phase === 'collector', 'collector closure phase')
  assert(artifacts.failures.length === 0, 'artifact owner failures')
  const files = acquisition.files.map((row) => {
    const owner = artifacts.handles.get(row.name)
    assert(owner?.sealed && owner.closedFile, 'artifact was not sealed: ' + row.name)
    assert(owner.closedFile.dev === row.dev && owner.closedFile.ino === row.ino, 'closed owner identity')
    guardClosedVersion(artifacts.directory, acquisition, owner.closedFile)
    return owner.closedFile
  })
  return { v: 1, phase, binding: acquisition.binding, root: acquisition.root, files }
}

function appendClosedCustody(directory, previous, name, owner, digest, size) {
  assert(name === ARTIFACTS[previous.files.length], 'next custody artifact')
  const file = path.join(directory, name)
  guardRoot(directory, previous.root)
  assert(owner.name === name && owner.stat, 'original new artifact owner')
  const stat = fs.lstatSync(file, { bigint: true })
  const row = closedFile(stat, name, digest)
  assert(
    stat.dev === owner.stat.dev && stat.ino === owner.stat.ino && stat.size === BigInt(size),
    'new artifact original owner changed'
  )
  guardFile(directory, previous.root, row, name)
  const phase = name === 'collector-exit.json' ? 'exit' : 'replay'
  const next = { v: 1, phase, binding: previous.binding, root: previous.root, files: [...previous.files, row] }
  guardClosedVersion(directory, next, row)
  return next
}
function readClosedArtifact(directory, name, limit) {
  assert(ARTIFACTS.includes(name), 'fixed artifact basename')
  const file = path.join(directory, name)
  return readBounded(file, limit)
}

function parseNdjson(bytes, maxRecords, maxLine, label) {
  assert(bytes.length === 0 || bytes[bytes.length - 1] === 10, label + ' final newline')
  const lines = bytes.length ? new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\n') : []
  assert(lines.length <= maxRecords, label + ' record count')
  return lines.map((line) => {
    assert(Buffer.byteLength(line) + 1 <= maxLine, label + ' line bound')
    const value = JSON.parse(line)
    assert(JSON.stringify(value) === line, label + ' canonical JSON')
    return value
  })
}

function writeNextArtifact(directory, previous, name, body, existingBytes, reserve = 0) {
  assert(name === ARTIFACTS[previous.files.length], 'next fixed artifact')
  const bytes = boundedJson(body, MAX_META)
  assert(
    Number.isSafeInteger(existingBytes) && existingBytes >= 0 && existingBytes + bytes.length + reserve <= MAX_TOTAL,
    'aggregate artifact budget'
  )
  guardRoot(directory, previous.root)
  for (const row of previous.files) guardClosedVersion(directory, previous, row)
  const file = path.join(directory, name)
  const fd = fs.openSync(file, 'wx+', 0o600)
  const owner = { name, fd, stat: null, closeAttempted: false, closeSucceeded: false }
  let hasPrimary = false
  let primary
  let digest = null
  let written = 0
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    owner.stat = before
    const acquired = fileIdentity(before, name)
    guardFile(directory, previous.root, acquired, name)
    assert(before.size === 0n, 'new artifact owner')
    while (written < bytes.length) {
      const count = fs.writeSync(fd, bytes, written, bytes.length - written, null)
      assert(count > 0, 'replay write progress')
      written += count
    }
    guardFile(directory, previous.root, acquired, name)
    const readback = readAllHeld(fd, written, MAX_META)
    assert(readback.equals(bytes), 'artifact readback')
    digest = hash(readback)
    fs.fsyncSync(fd)
    const after = fs.fstatSync(fd, { bigint: true })
    assert(after.dev === before.dev && after.ino === before.ino && after.size === BigInt(written), 'writer identity')
  } catch (error) {
    hasPrimary = true
    primary = error
  }
  try {
    owner.closeAttempted = true
    fs.closeSync(fd)
    owner.closeSucceeded = true
  } catch (error) {
    if (hasPrimary) throw new AggregateError([primary, error], 'artifact write and close failed')
    throw error
  }
  if (hasPrimary) throw primary
  const custody = appendClosedCustody(directory, previous, name, owner, digest, written)
  for (const row of previous.files) guardClosedVersion(directory, previous, row)
  return { bytes, custody }
}

function writeReplayReport(directory, previous, report, existingBytes) {
  return writeNextArtifact(directory, previous, 'replay.json', report, existingBytes)
}

function emitWorkflowOutputs(values) {
  const output = process.env.GITHUB_OUTPUT
  assert(typeof output === 'string' && path.isAbsolute(output), 'workflow output identity')
  let admitted = 0
  const rows = Object.entries(values).map(([key, value]) => {
    assert(/^[a-z_]{1,32}$/.test(key), 'workflow output key')
    assert(typeof value === 'boolean' || (typeof value === 'string' && !/[\r\n]/.test(value)), 'workflow output value')
    const wire = String(value)
    assert(wire.length <= MAX_OUTPUT, 'workflow output value code-unit budget')
    admitted += Buffer.byteLength(key) + 2 + Buffer.byteLength(wire)
    assert(admitted <= MAX_OUTPUT, 'workflow output aggregate preallocation budget')
    return key + '=' + wire + '\n'
  })
  const line = rows.join('')
  assert(Buffer.byteLength(line) <= MAX_OUTPUT, 'workflow output byte budget')
  const fd = fs.openSync(output, 'a')
  let hasPrimary = false
  let primary
  try {
    writeAll(fd, Buffer.from(line))
    fs.fsyncSync(fd)
  } catch (error) {
    hasPrimary = true
    primary = error
  }
  try {
    fs.closeSync(fd)
  } catch (error) {
    if (hasPrimary) throw new AggregateError([primary, error], 'workflow output and close failed')
    throw error
  }
  if (hasPrimary) throw primary
}

function caseRaw(state, origin, payload) {
  try {
    assert(state.ordinal < 192, 'per-case envelope count')
    assert(
      typeof payload === 'string' && payload.length <= MAX_PAYLOAD && Buffer.byteLength(payload) <= MAX_PAYLOAD,
      'application payload bound'
    )
    const envelope = { ordinal: state.ordinal + 1, origin, payload }
    const bytes = boundedJson(envelope, MAX_ENVELOPE)
    state.artifacts.append(state.id + '.events.ndjson', bytes)
    state.ordinal++
    const recorded = JSON.parse(payload)
    state.timeline.push({ ordinal: state.ordinal, origin, item: recorded })
    if (recorded.error && recorded.op !== 'fd-check')
      state.recordedErrors.push({ op: recorded.op, endpoint: recorded.endpoint, error: recorded.error })
    return true
  } catch (error) {
    stickyFailure(state, error)
    state.notify()
    return false
  }
}

function caseParentRecord(state, phase, op, endpoint, id, eventState, options = {}) {
  const payload = {
    v: 1,
    kind: 'parent',
    caseId: state.id,
    seq: state.parentSeq + 1,
    phase,
    op,
    endpoint,
    id,
    state: eventState,
    bytes: options.bytes ?? null,
    dataSha256: options.dataSha256 ?? null,
    result: options.result ?? null,
    error: options.error ?? null,
    childSeq: state.childSeq || null
  }
  try {
    replayEventShape(payload, state.id, payload.seq, 'parent')
  } catch (error) {
    stickyFailure(state, error)
    state.notify()
    return null
  }
  if (!caseRaw(state, 'parent', JSON.stringify(payload))) return null
  state.parentSeq++
  state.parentRecords.push(payload)
  state.notify()
  return payload
}

function globalParentRecord(artifacts, ordinalState, payload) {
  assert(
    payload.caseId === null &&
      payload.endpoint === 'process' &&
      ['spawn', 'case-release'].includes(payload.op) &&
      payload.id >= 1 &&
      payload.id <= 6,
    'global admission event'
  )
  jsonBytes(payload, MAX_PAYLOAD)
  const wire = JSON.stringify(payload)
  const line = boundedJson({ ordinal: ordinalState.ordinal + 1, origin: 'parent', payload: wire }, MAX_ENVELOPE)
  artifacts.append('parent.events.ndjson', line)
  ordinalState.ordinal++
}

function validateErrorProjection(value) {
  exactKeys(value, ['name', 'code', 'syscall', 'errno', 'messageSha256'], 'error projection')
  for (const key of ['name', 'code', 'syscall'])
    assert(
      value[key] === null ||
        (typeof value[key] === 'string' && value[key].length <= 64 && Buffer.byteLength(value[key]) <= 64),
      'error text bound'
    )
  assert(value.errno === null || Number.isSafeInteger(value.errno), 'error number')
  assert(typeof value.messageSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.messageSha256), 'error message digest')
}

function replayEventShape(item, id, seq, origin = 'child') {
  const keys = [
    'v',
    'kind',
    'caseId',
    'seq',
    'phase',
    'op',
    'endpoint',
    'id',
    'state',
    'bytes',
    'dataSha256',
    'result',
    'error'
  ]
  if (origin === 'parent') keys.push('childSeq')
  exactKeys(item, keys, origin + ' event')
  assert(
    item.v === 1 &&
      item.kind === (origin === 'child' ? 'event' : 'parent') &&
      item.caseId === id &&
      item.seq === seq &&
      PHASE.has(item.phase),
    'event identity'
  )
  assert(Number.isSafeInteger(item.id) && item.id >= 0 && item.id <= 32, 'event id')
  assert(
    item.bytes === null || (Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 524288),
    'event byte count'
  )
  assert(
    item.dataSha256 === null || (typeof item.dataSha256 === 'string' && /^[0-9a-f]{64}$/.test(item.dataSha256)),
    'event digest'
  )
  if (item.error !== null) validateErrorProjection(item.error)
  if (origin === 'parent')
    assert(
      item.childSeq === null || (Number.isSafeInteger(item.childSeq) && item.childSeq >= 1 && item.childSeq <= 128),
      'parent child frontier'
    )
  const child = {
    acquire: [['reader3', 'writer4'], [0], ['fulfilled', 'rejected']],
    goal: [
      ['none', 'reader3', 'writer4'],
      [0, 2],
      ['start', 'rejected']
    ],
    'api-write': [['writer4'], [1, 2], ['start', 'observed', 'fulfilled', 'rejected', 'threw']],
    'fs-read': [['reader3'], null, ['start', 'fulfilled', 'rejected', 'threw']],
    'fs-write': [['writer4'], null, ['start', 'fulfilled', 'rejected', 'threw']],
    'fs-writev': [['writer4'], null, ['start', 'fulfilled', 'rejected', 'threw']],
    'fs-close': [['reader3', 'writer4'], null, ['start', 'fulfilled', 'rejected', 'threw']],
    'socket-read': [['reader3', 'writer4'], [0], ['observed']],
    'peer-read': [['reader3'], [0], ['observed']],
    'stream-end': [['reader3', 'writer4'], [0], ['observed']],
    'stream-error': [['reader3', 'writer4'], [0], ['rejected']],
    'stream-close': [['reader3', 'writer4'], [0], ['observed']],
    'fd-check': [['reader3', 'writer4'], [0], ['observed', 'rejected']],
    'local-destroy': [['reader3', 'writer4'], [0], ['requested']],
    fatal: [['ipc'], [0], ['rejected']]
  }
  const parent = {
    'api-write': [
      ['reader3', 'writer4'],
      [1, 2],
      ['start', 'observed', 'fulfilled', 'rejected', 'threw']
    ],
    'peer-read': [['writer4'], [0], ['observed']],
    'peer-pause': [['writer4'], [0], ['requested']],
    'peer-resume': [['writer4'], [0], ['requested']],
    'peer-end': [['reader3'], [0], ['requested', 'observed', 'fulfilled', 'rejected', 'threw']],
    'peer-destroy': [['reader3', 'writer4'], [0], ['requested']],
    'peer-close': [['reader3', 'writer4'], [0], ['observed']],
    'stream-end': [['reader3', 'writer4', 'process'], [0], ['observed']],
    'stream-error': [['reader3', 'writer4', 'process'], [0], ['rejected']],
    'stream-close': [['process'], [0], ['observed']],
    spawn: [['process'], [0], ['start', 'fulfilled', 'rejected', 'threw']],
    'ipc-send': [['ipc'], null, ['start', 'fulfilled', 'rejected', 'threw']],
    'ipc-disconnect': [['ipc'], [0], ['observed']],
    'frontier-fsync': [['ipc'], [0], ['fulfilled']],
    'infra-term': [['process'], [0], ['start', 'requested']],
    fatal: [['process', 'reader3', 'writer4', 'ipc'], [0], ['observed']],
    'drain-expiry': [['writer4'], [0], ['observed']]
  }
  const rule = (origin === 'child' ? child : parent)[item.op]
  assert(rule && rule[0].includes(item.endpoint) && rule[2].includes(item.state), 'closed event tuple')
  assert(
    rule[1] === null ? item.id >= 1 && item.id <= (item.op === 'ipc-send' ? 12 : 32) : rule[1].includes(item.id),
    'event operation id'
  )
  if (item.op === 'api-write')
    assert(
      origin === 'child'
        ? item.endpoint === 'writer4' && (item.id === 1 || (BULK.has(id) && item.id === 2))
        : (item.endpoint === 'reader3' && item.id === 1) ||
            (SOCKET.has(id) && item.endpoint === 'writer4' && item.id === 2),
      'public write namespace'
    )
  if (item.op === 'goal')
    assert(
      item.state === 'start'
        ? item.endpoint === 'none' && item.id === 0
        : (item.endpoint === 'reader3' && item.id === 0) || (item.endpoint === 'writer4' && item.id === 2),
      'goal identity'
    )
  if (item.op.startsWith('fs-')) assert(!SOCKET.has(id), 'FS case family')
  if (item.op === 'socket-read') assert(SOCKET.has(id), 'Socket case family')
  if (item.op === 'acquire' || item.op === 'spawn' || item.op === 'peer-pause')
    assert(item.phase === 'setup', 'setup event phase')
  if (item.op === 'goal' && item.state === 'start') assert(item.phase === 'goal', 'goal admission phase')
  if (item.op === 'goal' && item.state === 'rejected')
    assert(['setup', 'goal'].includes(item.phase), 'goal refusal phase')
  if (
    item.op === 'peer-resume' ||
    item.op === 'drain-expiry' ||
    item.op === 'infra-term' ||
    item.op === 'frontier-fsync'
  )
    assert(item.phase === 'rescue', 'rescue event phase')
  if (item.op === 'local-destroy') assert(['goal', 'rescue'].includes(item.phase), 'local destroy phase')
  const data =
    item.op === 'socket-read' ||
    item.op === 'peer-read' ||
    (item.op === 'api-write' && ['start', 'fulfilled', 'rejected'].includes(item.state)) ||
    (item.op === 'fs-read' && item.state === 'fulfilled' && item.bytes > 0) ||
    item.op === 'frontier-fsync'
  if (data)
    assert(
      item.bytes !== null && item.dataSha256 !== null && (item.op === 'frontier-fsync' || item.bytes > 0),
      'data byte/hash binding'
    )
  else assert(item.dataSha256 === null, 'unexpected digest')
  const transfer = item.op === 'fs-read' || item.op === 'fs-write' || item.op === 'fs-writev'
  if (transfer && item.state === 'start') assert(['setup', 'goal'].includes(item.phase), 'ordinary native start phase')
  if (transfer && ['start', 'fulfilled'].includes(item.state))
    assert(Number.isSafeInteger(item.bytes) && item.bytes >= 0, 'actual native transfer byte count')
  if (!data && !(transfer && ['start', 'fulfilled'].includes(item.state)))
    assert(item.bytes === null, 'unexpected byte count')
  if (item.op === 'api-write' && item.state === 'observed')
    assert(typeof item.result === 'boolean', 'original write return')
  else if (item.op === 'stream-close' && origin === 'child' && SOCKET.has(id))
    assert(typeof item.result === 'boolean', 'Socket hadError')
  else if (item.op === 'infra-term' && item.state === 'requested')
    assert(typeof item.result === 'boolean', 'actual signal return')
  else assert(item.result === null, 'unexpected result')
  const actualError =
    item.state === 'threw' ||
    item.op === 'stream-error' ||
    item.op === 'fatal' ||
    (item.state === 'rejected' && item.op !== 'goal')
  assert(actualError ? item.error !== null : item.error === null, 'event error tuple')
}

function verifySourceBinding(collector, meta, freshGit = true) {
  exactKeys(
    collector,
    ['schema', 'base', 'source', 'run', 'roster', 'cases', 'diagnosticStatus', 'safeToUpload', 'rawFiles', 'custody'],
    'collector manifest'
  )
  assert(collector.schema === SCHEMA && collector.base === BASE, 'collector schema/base')
  assert(
    ['COMPLETE', 'PARTIAL'].includes(collector.diagnosticStatus) && collector.safeToUpload === false,
    'collector diagnostic/publication fields'
  )
  exactKeys(
    collector.source,
    ['head', 'branch', 'base', 'files', 'sourceSetSha256', 'runtime', 'execPath', 'runtimeExecutableSha256', 'run'],
    'source fence'
  )
  assert(collector.source.head === process.env.GITHUB_SHA, 'collector source head')
  assert(
    collector.source.branch === 'fix/qa-fixed-stdio-native' && collector.source.base === BASE,
    'collector source branch/base'
  )
  exactKeys(collector.run, ['runId', 'attempt', 'job', 'target', 'ref', 'workflowRef'], 'run binding')
  assert(
    collector.run.runId === meta.runId &&
      collector.run.attempt === meta.attempt &&
      collector.run.job === meta.job &&
      collector.run.target === meta.target &&
      collector.run.ref === meta.ref &&
      collector.run.workflowRef === meta.workflowRef,
    'collector run identity'
  )
  assert(JSON.stringify(collector.source.runtime) === JSON.stringify(meta.runtime), 'collector runtime identity')
  assert(
    typeof collector.source.execPath === 'string' && collector.source.execPath === process.execPath,
    'Node executable path'
  )
  assert(/^[0-9a-f]{64}$/.test(collector.source.runtimeExecutableSha256), 'Node executable digest')
  assert(JSON.stringify(collector.source.run) === JSON.stringify(collector.run), 'source/run mismatch')
  assert(Array.isArray(collector.source.files) && collector.source.files.length === SOURCES.length, 'source roster')
  for (const [index, file] of collector.source.files.entries()) {
    exactKeys(file, ['path', 'blobId', 'gitSha256', 'checkoutSha256', 'projection', 'bytes'], 'source file binding')
    assert(
      file.path === SOURCES[index] &&
        /^[0-9a-f]{40}$/.test(file.blobId) &&
        /^[0-9a-f]{64}$/.test(file.gitSha256) &&
        /^[0-9a-f]{64}$/.test(file.checkoutSha256) &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 &&
        file.bytes <= 256 * 1024 &&
        ['identical', 'git-lf-to-checkout-crlf'].includes(file.projection),
      'source file identity'
    )
    const current = readBounded(path.join(process.cwd(), file.path), 256 * 1024)
    assert(hash(current) === file.checkoutSha256, 'checkout source changed after collection')
  }
  assert(
    collector.source.sourceSetSha256 === hash(Buffer.from(JSON.stringify(collector.source.files))),
    'source-set digest'
  )
  if (freshGit) {
    const fresh = sourceFence(meta)
    assert(
      JSON.stringify(fresh.files) === JSON.stringify(collector.source.files) &&
        fresh.sourceSetSha256 === collector.source.sourceSetSha256,
      'recorded Git source set differs from replay Git'
    )
  }
  assert(
    Array.isArray(collector.roster) &&
      collector.roster.length === 6 &&
      collector.roster.every((row, index) => {
        exactKeys(row, ['id', 'name'], 'fixed case roster row')
        return row.id === IDS[index] && row.name === NAMES[index]
      }),
    'six-case roster'
  )
  assert(Array.isArray(collector.cases) && collector.cases.length === 6, 'six-case manifest')
  exactKeys(collector.rawFiles, ['parent', 'collector', 'cases'], 'collector raw file map')
  exactKeys(collector.rawFiles.parent, ['path', 'size', 'sha256'], 'parent raw binding')
  exactKeys(collector.rawFiles.collector, ['path', 'size', 'sha256'], 'collector raw binding')
  assert(
    collector.rawFiles.parent.path === 'parent.events.ndjson' && collector.rawFiles.collector.path === 'collector.json',
    'collector raw paths'
  )
  assert(
    Number.isSafeInteger(collector.rawFiles.parent.size) &&
      collector.rawFiles.parent.size >= 0 &&
      collector.rawFiles.parent.size <= MAX_META &&
      collector.rawFiles.parent.sha256 === null &&
      Number.isSafeInteger(collector.rawFiles.collector.size) &&
      collector.rawFiles.collector.size >= 0 &&
      collector.rawFiles.collector.size <= MAX_META &&
      collector.rawFiles.collector.sha256 === null,
    'collector aggregate byte claims'
  )
  exactKeys(collector.rawFiles.cases, IDS.flatMap(namesFor), 'collector case file roster')
  for (const name of IDS.flatMap(namesFor)) {
    const entry = collector.rawFiles.cases[name]
    exactKeys(entry, ['size', 'sha256'], 'collector case file claim')
    assert(
      Number.isSafeInteger(entry.size) &&
        entry.size >= 0 &&
        entry.size <= artifactLimit(name) &&
        typeof entry.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(entry.sha256),
      'collector case file size/digest'
    )
  }
}

function verifyCaseSummary(row, id) {
  exactKeys(
    row,
    [
      'id',
      'name',
      'attempted',
      'capability',
      'diagnosticStatus',
      'naturalClose',
      'exitCode',
      'signal',
      'callbackJoins',
      'processClose',
      'peer3Closed',
      'peer4Closed',
      'stderrClosed',
      'ipcDisconnected',
      'sample',
      'frontier',
      'terminated',
      'signals',
      'safeOwnership',
      'stderrOverflow',
      'stderrSha256',
      'eventsSha256',
      'peerInputSha256',
      'peerOutputSha256',
      'errors'
    ],
    'case manifest row'
  )
  assert(
    row.id === id && row.name === NAMES[IDS.indexOf(id)] && typeof row.attempted === 'boolean',
    'case manifest identity'
  )
  assert(
    OUTCOMES.has(row.capability) && ['COMPLETE', 'PARTIAL', 'INVALID'].includes(row.diagnosticStatus),
    'case manifest status'
  )
  for (const key of [
    'naturalClose',
    'callbackJoins',
    'processClose',
    'peer3Closed',
    'peer4Closed',
    'stderrClosed',
    'ipcDisconnected',
    'terminated',
    'safeOwnership',
    'stderrOverflow'
  ])
    assert(typeof row[key] === 'boolean', 'case flag type: ' + key)
  assert(row.exitCode === null || Number.isSafeInteger(row.exitCode), 'case exit code')
  assert(row.signal === null || (typeof row.signal === 'string' && Buffer.byteLength(row.signal) <= 16), 'case signal')
  if (row.sample !== null) {
    exactKeys(row.sample, ['seq', 'ordinal', 'bytes'], 'case sample')
    assert(
      Number.isSafeInteger(row.sample.seq) &&
        row.sample.seq >= 1 &&
        row.sample.seq <= 128 &&
        Number.isSafeInteger(row.sample.ordinal) &&
        row.sample.ordinal >= 1 &&
        row.sample.ordinal <= 192 &&
        Number.isSafeInteger(row.sample.bytes) &&
        row.sample.bytes >= 0 &&
        row.sample.bytes <= MAX_CASE,
      'case sample bounds'
    )
  }
  if (row.frontier !== null) {
    exactKeys(row.frontier, ['bytes', 'sha256', 'ordinal', 'childSeq'], 'case frontier')
    assert(
      Number.isSafeInteger(row.frontier.bytes) &&
        row.frontier.bytes >= 0 &&
        row.frontier.bytes <= MAX_CASE &&
        typeof row.frontier.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(row.frontier.sha256) &&
        Number.isSafeInteger(row.frontier.ordinal) &&
        row.frontier.ordinal >= 1 &&
        row.frontier.ordinal <= 192 &&
        (row.frontier.childSeq === null ||
          (Number.isSafeInteger(row.frontier.childSeq) && row.frontier.childSeq >= 1 && row.frontier.childSeq <= 128)),
      'case frontier bounds'
    )
  }
  assert(Array.isArray(row.signals) && row.signals.length <= 2, 'case signals')
  row.signals.forEach((signal, index) => {
    exactKeys(signal, ['name', 'result'], 'case signal')
    assert(
      signal.name === (index === 0 ? 'SIGTERM' : 'SIGKILL') &&
        (signal.result === null || typeof signal.result === 'boolean'),
      'signal outcome'
    )
  })
  for (const key of ['stderrSha256', 'eventsSha256', 'peerInputSha256', 'peerOutputSha256']) {
    assert(row[key] === null || (typeof row[key] === 'string' && /^[0-9a-f]{64}$/.test(row[key])), 'case file digest')
  }
  assert(Array.isArray(row.errors) && row.errors.length <= 192, 'case errors')
  for (const entry of row.errors) {
    exactKeys(entry, ['op', 'endpoint', 'error'], 'case observed error')
    assert(OP.has(entry.op) && typeof entry.endpoint === 'string', 'case error source')
    validateErrorProjection(entry.error)
  }
  if (row.attempted === false)
    assert(
      row.capability === 'INCOMPLETE_INFRA' &&
        row.diagnosticStatus === 'PARTIAL' &&
        row.naturalClose === false &&
        row.exitCode === null &&
        row.signal === null &&
        row.callbackJoins === false &&
        row.processClose === false &&
        row.peer3Closed === false &&
        row.peer4Closed === false &&
        row.stderrClosed === false &&
        row.ipcDisconnected === false &&
        row.sample === null &&
        row.frontier === null &&
        row.terminated === false &&
        row.signals.length === 0 &&
        row.safeOwnership === false &&
        row.stderrOverflow === false &&
        row.errors.length === 0,
      'unattempted absence'
    )
}

function readFooter(stderr, id) {
  const lines = stderr
    .toString('utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('METIS_N0_EXIT '))
  if (lines.length !== 1) return null
  const wire = lines[0].slice('METIS_N0_EXIT '.length)
  const footer = JSON.parse(wire)
  assert(JSON.stringify(footer) === wire, 'canonical exit footer')
  exactKeys(
    footer,
    [
      'v',
      'kind',
      'caseId',
      'issuedSends',
      'completedSends',
      'finalSendCallback',
      'finalSendState',
      'finalSendError',
      'uncaughtExceptionCount',
      'unhandledRejectionCount',
      'exitCode'
    ],
    'actual child footer'
  )
  assert(footer.v === 1 && footer.kind === 'exit-footer' && footer.caseId === id, 'actual footer binding')
  for (const key of ['issuedSends', 'completedSends', 'uncaughtExceptionCount', 'unhandledRejectionCount']) {
    assert(Number.isSafeInteger(footer[key]) && footer[key] >= 0 && footer[key] <= 128, 'actual footer count')
  }
  assert(
    typeof footer.finalSendCallback === 'boolean' &&
      Number.isSafeInteger(footer.exitCode) &&
      footer.exitCode >= 0 &&
      footer.exitCode <= 255 &&
      footer.completedSends <= footer.issuedSends,
    'actual footer terminal'
  )
  assert(
    ['unissued', 'pending', 'callback-fulfilled', 'callback-rejected', 'threw'].includes(footer.finalSendState),
    'final send state'
  )
  assert(footer.finalSendCallback === footer.finalSendState.startsWith('callback-'), 'final send callback truth')
  if (['callback-rejected', 'threw'].includes(footer.finalSendState)) validateErrorProjection(footer.finalSendError)
  else assert(footer.finalSendError === null, 'unexpected final send error')
  return footer
}

function parseAggregate(bytes, label) {
  const wire = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  assert(wire.endsWith('\n'), label + ' final newline')
  const value = JSON.parse(wire.slice(0, -1))
  assert(JSON.stringify(value) + '\n' === wire, label + ' canonical JSON')
  return value
}

async function recordCollectorExit() {
  const meta = provenance()
  const directory = runnerDirectory(meta)
  const status = process.env.COLLECTOR_EXIT_CODE
  assert(status === '0' || status === '1', 'actual collector status')
  assert(process.env.METIS_N0_OWNED_CLOSED === 'true', 'collector owner output')
  const custody = parseCustody(process.env.METIS_N0_CUSTODY, directory, meta, 'collector')
  assert(
    JSON.stringify(fs.readdirSync(directory).sort()) === JSON.stringify(ARTIFACTS.slice(0, 26).sort()),
    'exit exact acquired roster'
  )
  const bytes = new Map()
  for (const row of custody.files) bytes.set(row.name, readCustodyFile(directory, custody, row.name))
  const collector = parseAggregate(bytes.get('collector.json'), 'collector')
  verifySourceBinding(collector, meta, false)
  assert(
    (await hashExecutable(process.execPath)) === collector.source.runtimeExecutableSha256,
    'Node executable changed'
  )
  assert(JSON.stringify(custody.binding) === JSON.stringify(bindingFor(meta, collector.source)), 'exit source custody')
  const acquisition = collector.custody
  exactKeys(acquisition, ['v', 'binding', 'root', 'files'], 'collector acquisition custody')
  assert(
    acquisition.v === 1 &&
      JSON.stringify(acquisition.binding) === JSON.stringify(custody.binding) &&
      JSON.stringify(acquisition.root) === JSON.stringify(custody.root),
    'collector acquisition root'
  )
  assert(Array.isArray(acquisition.files) && acquisition.files.length === 26, 'collector acquisition roster')
  acquisition.files.forEach((row, index) => {
    exactKeys(row, ['name', 'dev', 'ino'], 'collector acquired file')
    assert(
      row.name === ARTIFACTS[index] && row.dev === custody.files[index].dev && row.ino === custody.files[index].ino,
      'collector acquired identity'
    )
  })
  for (const [index, id] of IDS.entries()) verifyCaseSummary(collector.cases[index], id)
  assert(collector.safeToUpload === false, 'collector cannot authorize upload')
  const parent = bytes.get('parent.events.ndjson')
  const records = parseNdjson(parent, 13, MAX_ENVELOPE, 'parent exit history')
  const final = records.at(-1)
  assert(final?.origin === 'parent' && Number.isSafeInteger(final.ordinal), 'parent exit envelope')
  const footer = JSON.parse(final.payload)
  assert(
    JSON.stringify(footer) === final.payload &&
      footer.kind === 'exit-footer' &&
      footer.caseId === null &&
      footer.exitCode === Number(status),
    'actual parent exit/footer'
  )
  exactKeys(
    footer,
    [
      'v',
      'kind',
      'caseId',
      'issuedSends',
      'completedSends',
      'finalSendCallback',
      'finalSendState',
      'finalSendError',
      'uncaughtExceptionCount',
      'unhandledRejectionCount',
      'exitCode'
    ],
    'parent exit footer'
  )
  assert(
    footer.v === 1 &&
      footer.finalSendCallback === null &&
      footer.finalSendState === null &&
      footer.finalSendError === null,
    'parent footer fields'
  )
  for (const key of ['issuedSends', 'completedSends', 'uncaughtExceptionCount', 'unhandledRejectionCount'])
    assert(
      Number.isSafeInteger(footer[key]) && footer[key] >= 0 && footer[key] <= (key.includes('Sends') ? 72 : 128),
      'parent footer counter'
    )
  assert(
    collector.rawFiles.parent.size === parent.length - Buffer.byteLength(JSON.stringify(final) + '\n'),
    'parent prefix size'
  )
  assert(collector.rawFiles.collector.size === bytes.get('collector.json').length, 'collector self size')
  const body = {
    schema: SCHEMA,
    sourceHead: collector.source.head,
    runId: meta.runId,
    attempt: meta.attempt,
    target: meta.target,
    shellExitCode: Number(status),
    custody
  }
  const existingBytes = [...bytes.values()].reduce((sum, value) => sum + value.length, 0)
  const written = writeNextArtifact(directory, custody, 'collector-exit.json', body, existingBytes, MAX_META)
  for (const row of custody.files) guardFile(directory, custody.root, row, row.name)
  emitWorkflowOutputs({ custody: custodyText(written.custody) })
}

function collectorCaseRow(state, artifacts) {
  const id = state.id
  const digest = (suffix) => artifacts.hashes.get(id + suffix) ?? null
  return {
    id,
    name: NAMES[IDS.indexOf(id)],
    attempted: state.attempted,
    capability: OUTCOMES.has(state.outcome) ? state.outcome : 'INCOMPLETE_INFRA',
    diagnosticStatus: state.diagnostic,
    naturalClose: Boolean(state.processClose && state.processExit?.code === 0 && state.processExit?.signal === null),
    exitCode: state.processExit?.code ?? null,
    signal: state.processExit?.signal ?? null,
    processClose: state.processClose,
    peer3Closed: state.peer3Closed,
    peer4Closed: state.peer4Closed,
    stderrClosed: state.stderrClosed,
    ipcDisconnected: state.ipcDisconnected,
    sample: state.sample,
    frontier: state.frontier ?? null,
    terminated: state.terminated,
    signals: state.signals,
    safeOwnership: state.safeOwnership,
    callbackJoins:
      state.attempted &&
      state.peerWrites === state.peerWriteCallbacks + state.parentWriteThrew &&
      state.peerEndsIssued === state.peerEndsCompleted + state.peerEndsThrew &&
      state.parentSendsIssued === state.parentSendsCompleted + state.parentSendsThrew &&
      state.parentPublicPending.size === 0,
    stderrOverflow: state.stderrOverflow,
    stderrSha256: digest('.stderr.raw.log'),
    eventsSha256: digest('.events.ndjson'),
    peerInputSha256: digest('.peer-input.bin'),
    peerOutputSha256: digest('.peer-output.bin'),
    errors: state.recordedErrors
  }
}

export {
  BASE,
  SCHEMA,
  ENTRY,
  WORKFLOW,
  CHILD,
  EVIDENCE,
  REPLAY,
  SOURCES,
  ARTIFACTS,
  IDS,
  NAMES,
  SOCKET,
  BULK,
  OP,
  PHASE,
  STATES,
  OUTCOMES,
  TARGETS,
  MAX_TOTAL,
  MAX_META,
  MAX_CASE,
  MAX_STDERR,
  MAX_PEER_OUT,
  MAX_PAYLOAD,
  MAX_ENVELOPE,
  EXIT_RESERVE,
  MAX_CUSTODY,
  MAX_OUTPUT,
  encoder,
  assert,
  hash,
  digestText,
  exactKeys,
  jsonBytes,
  boundedJson,
  errorProjection,
  stickyFailure,
  safeRuntime,
  readBounded,
  writeAll,
  readAllHeld,
  readHeldPrefix,
  sourceCommand,
  hashExecutable,
  provenance,
  sourceFence,
  runnerDirectory,
  bindingFor,
  captureRoot,
  guardRoot,
  guardFile,
  guardClosedVersion,
  custodyText,
  parseCustody,
  readCustodyFile,
  acquiredCustody,
  closedCustody,
  appendClosedCustody,
  namesFor,
  artifactLimit,
  createArtifacts,
  closeArtifactRegistry,
  readClosedArtifact,
  parseNdjson,
  caseRaw,
  caseParentRecord,
  globalParentRecord,
  collectorCaseRow,
  replayEventShape,
  validateErrorProjection,
  verifySourceBinding,
  verifyCaseSummary,
  readFooter,
  parseAggregate,
  recordCollectorExit,
  writeNextArtifact,
  writeReplayReport,
  emitWorkflowOutputs
}
