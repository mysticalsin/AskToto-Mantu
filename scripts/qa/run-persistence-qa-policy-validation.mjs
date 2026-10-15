#!/usr/bin/env node

import { randomBytes, createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
  fsyncSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { titles as EXPECTED_TESTS, rowIds as ROW_IDS, validP15 } from './persistence-policy-reporter.mjs'

export const POLICY_TEST_FILE = 'src/main/persistence/resource-policy.test.ts'
export const INITIAL_NAME = 'initialization.json'
export const RAW_NAME = 'persistence-qa-policy-tests.json'
export const RUNTIME_NAME = 'persistence-qa-policy-runtime.json'
export const STDOUT_NAME = 'persistence-qa-policy-stdout.log'
export const STDERR_NAME = 'persistence-qa-policy-stderr.log'
export const STATUS_NAME = 'qualification-status.json'
export const BASELINE = '230c8efef60dd847dc9f6e4b52b8f4d9c67e75f2'
export const P0_COMMIT = '0d582cce4ce74bec1bad89229e37b247711ac5c1'
export const BASE_POLICY_SHA = 'b0fcc1870499aba4233c0ee14711698490f5c369dfc4ea3c7146837b069d4c23'
export const PHASE = 'P15_POLICY_GREEN'
export const ALLOWED = [
  '.github/workflows/persistence-qa-policy-contract.yml',
  'scripts/qa/persistence-policy-reporter.mjs',
  'scripts/qa/run-persistence-qa-policy-validation.mjs',
  POLICY_TEST_FILE,
  'src/main/persistence/resource-policy.ts'
].sort()
const DIRECT_SUCCESSOR = [
  'scripts/qa/run-persistence-qa-policy-validation.mjs',
  'src/main/persistence/resource-policy.ts'
].sort()
const RUNNER_PATH = 'scripts/qa/run-persistence-qa-policy-validation.mjs'
const LIMITS = new Map([
  [INITIAL_NAME, 4 * 1024],
  [RAW_NAME, 1024 * 1024],
  [RUNTIME_NAME, 64 * 1024],
  [STDOUT_NAME, 2 * 1024 * 1024],
  [STDERR_NAME, 2 * 1024 * 1024],
  [STATUS_NAME, 64 * 1024]
])
const SOURCE_PINS = [
  ['src/main/persistence/resource-policy.ts', BASE_POLICY_SHA],
  [POLICY_TEST_FILE, 'f623d0f8af9c25f9415f66a033f7eca8477edc0b0a16bb6d65fa48e8e4eb3242'],
  [
    'src/main/persistence/resource-policy-contract.ts',
    '86fe64d9cf9a86ffba7a3d854b76c5225f892e549f5de075a58d8226bc56b573'
  ],
  ['resources/persistence-profiles.v1.json', '9d67a074e82a94a7e9dc10bc1c10190700830a7d4de4cb041f7cbacc11f7282f'],
  [
    '.github/workflows/persistence-qa-policy-contract.yml',
    '22e1c2eae13ebb5d4b0264a500197ade2aff0bc98e5435b478479a62d92683c6'
  ],
  [RUNNER_PATH, null],
  ['scripts/qa/persistence-policy-reporter.mjs', '8e7e3e61ed0b2e85feeeedea40acad80de2946ffda1b0bb385281640be0e439f'],
  ['src/main/win-security.ts', '9286a7ebabdbc9985fbdcc95ffea1463df7251f98ea100a041909d2df48c3e85'],
  ['src/main/persistence/bootstrap.ts', 'af2f9f28e26c998798987b2eb4356c8b638d9947a5242329ea0fb252df6b38fa'],
  ['src/main/persistence/policy-high-water.ts', '31d2f2f1059ddc675131c0b163c6f1330c6585f83aaaebc9a7ed297c8f1d1ecb'],
  [
    'src/main/persistence/policy-high-water.test.ts',
    '67793356545edd761c1f6a5ade96377af7adfc0aa3ec91055422c62fd6c39d8a'
  ],
  ['src/main/license-lease-verify.ts', '374ef1fa13a89a8966dc748fb6e2860ac6bcc20a1a1b997cb62cde4e130ef450'],
  ['src/main/logger.ts', '037a9cf2a0f6bdcdd1d3374f3aa48a3de510dff0a162b5d8f840b3fd19b42dff'],
  ['src/main/infra/process/exec-file.ts', '850ff8db0d304ff14ebf83c56136ed7cb0466c9e5c78a18d45abe82af95d2e7b'],
  ['vitest.config.ts', 'bd622050a3af3bce5e50e78b9fb5c63192b6d98150caa1b2fe34f84e96e6ac91'],
  ['electron.vite.config.ts', '37b18ad210db7fdb88bbc153579e6af17128e49a7fa7bde56a86eab4f4ff6d2c'],
  ['scripts/hermetic/sandbox-env.mjs', '2a884cdc1707970707beb9d0ec33d357f6f6005ac7d558c78f0ec6c6af85e3ff'],
  ['package.json', '6453fab47100fc8a0d0e94e022e5dee14f983ab487758d42a65739d3b42d51a8'],
  ['package-lock.json', '93d8825871866af420803b4a06b2be15c287bc902a60bfbf9333a7c47333b00b'],
  ['__mocks__/electron.ts', '0d928e1468d23dacc97dad4a9b3c86c681937987fb78a9c6c1b16568909bd182']
]
const API_SOURCE = [
  ['node_modules/vitest/package.json', 'a28126d97bcaf567da5bed69443b7f3bcd9a7a8c38c8b66e554686b6bb2c10e0'],
  [
    'node_modules/vitest/dist/chunks/reporters.d.DtoKVV2s.d.ts',
    '7fa6fdc6eeeb3850e6b3166836f8c9199594c4f4bed3cee02cac0ca33d71894d'
  ],
  [
    'node_modules/vitest/dist/chunks/cli-api.CnMVyzaz.js',
    'a236001d048380e2c67d05423fc9ea3f26b07ee019ba8d6e622082f29d49102e'
  ],
  [
    'node_modules/vitest/dist/chunks/index.UpGiHP7g.js',
    'cdafaf8e508042dddba72f8c7bbae84e2836ddb6b06c7026520c35d91af4e798'
  ],
  [
    'node_modules/@vitest/runner/dist/tasks.d-DEYaIMIu.d.ts',
    '53cf4076f42b29b8d411259d168d51b3a0274c42c8814e5b44dfa8803a35d4fc'
  ],
  [
    'node_modules/@vitest/runner/dist/chunk-artifact.js',
    'bf6af6d2f4469911879a67e83b8f9e7b20332cf42795032c53457b10ccc1c617'
  ],
  ['node_modules/vitest/vitest.mjs', '39db22f579acf5639bbb17a261408debbde03f4692c0c439e77e7f13aeba74d6']
]
const EVIDENCE_NAMES = [RAW_NAME, RUNTIME_NAME, STDOUT_NAME, STDERR_NAME, INITIAL_NAME].sort()
let lastProcessState = { exitCode: null, signal: null, error: 'other' }
let installedVitestVersion = null

function validIdentity() {
  const workflowFields = [process.env.GITHUB_REPOSITORY, process.env.GITHUB_REF]
  return (
    process.env.GITHUB_SHA &&
    /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA) &&
    /^[0-9]{1,32}$/.test(process.env.GITHUB_RUN_ID || '') &&
    /^[1-9][0-9]{0,3}$/.test(process.env.GITHUB_RUN_ATTEMPT || '') &&
    Number(process.env.GITHUB_RUN_ATTEMPT) <= 1000 &&
    ['ubuntu-latest', 'macos-latest', 'windows-latest'].includes(process.env.PERSISTENCE_QA_POLICY_TARGET || '') &&
    /^[0-9a-f]{40}$/.test(process.env.GITHUB_WORKFLOW_SHA || '') &&
    process.env.GITHUB_WORKFLOW_REF ===
      `${process.env.GITHUB_REPOSITORY}/.github/workflows/persistence-qa-policy-contract.yml@${process.env.GITHUB_REF}` &&
    workflowFields.every((value) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 256)
  )
}

function fail(message) {
  throw new Error(message)
}

function inside(base, target) {
  const rel = relative(base, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function fileSnapshot(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode),
    nlink: Number(stat.nlink),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs ?? BigInt(Math.trunc(Number(stat.mtimeMs) * 1e6))),
    ctimeNs: String(stat.ctimeNs ?? BigInt(Math.trunc(Number(stat.ctimeMs) * 1e6)))
  }
}

function sameSnapshot(left, right) {
  return exactKeys(right, Object.keys(left)) && Object.keys(left).every((key) => left[key] === right[key])
}

function withFd(fd, action) {
  let result
  let operationError
  let closeError
  try {
    result = action(fd)
  } catch (error) {
    operationError = error
  }
  try {
    closeSync(fd)
  } catch (error) {
    closeError = error
  }
  if (operationError && closeError) throw new AggregateError([operationError, closeError], 'operation and close failed')
  if (operationError) throw operationError
  if (closeError) throw closeError
  return result
}

function completeWrite(fd, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset)
    if (!Number.isInteger(count) || count <= 0 || count > bytes.length - offset) fail('invalid write progress')
    offset += count
  }
}

function canonicalJson(bytes, allowLf) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value = JSON.parse(text)
  const compact = JSON.stringify(value)
  if (text !== compact && (!allowLf || text !== `${compact}\n`)) fail('noncanonical JSON artifact')
  return value
}

function readBoundedFile(path, max) {
  const before = lstatSync(path, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n || before.size > BigInt(max))
    fail('invalid bounded file')
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0))
  return withFd(fd, () => {
    const heldBefore = fstatSync(fd, { bigint: true })
    if (!sameSnapshot(fileSnapshot(before), fileSnapshot(heldBefore))) fail('file changed before read')
    const chunks = []
    let total = 0
    const chunk = Buffer.alloc(Math.min(64 * 1024, max + 1))
    while (total <= max) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, max + 1 - total), null)
      if (count === 0) break
      total += count
      if (total > max) fail('file exceeded bound')
      chunks.push(Buffer.from(chunk.subarray(0, count)))
    }
    const heldAfter = fileSnapshot(fstatSync(fd, { bigint: true }))
    const namedAfter = fileSnapshot(lstatSync(path, { bigint: true }))
    if (
      !sameSnapshot(fileSnapshot(before), heldAfter) ||
      !sameSnapshot(heldAfter, namedAfter) ||
      total !== heldAfter.size
    )
      fail('file changed during read')
    return { bytes: Buffer.concat(chunks, total), version: heldAfter }
  })
}

function owner() {
  const root = process.cwd()
  const temp = process.env.RUNNER_TEMP
  const supplied = process.env.PERSISTENCE_QA_POLICY_REPORT_DIR
  if (!temp || !supplied || !isAbsolute(temp) || !isAbsolute(supplied)) fail('artifact roots must be absolute')
  const realRoot = realpathSync(root)
  const realTemp = realpathSync(temp)
  const tempStat = lstatSync(temp, { bigint: true })
  const directory = realpathSync(supplied)
  const suppliedStat = lstatSync(supplied, { bigint: true })
  if (
    tempStat.isSymbolicLink() ||
    resolve(temp) !== realTemp ||
    !inside(realTemp, directory) ||
    directory === realRoot ||
    inside(realRoot, directory)
  )
    fail('artifact directory is outside owned RUNNER_TEMP')
  const parentStat = statSync(realTemp, { bigint: true })
  const directoryStat = lstatSync(directory, { bigint: true })
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    suppliedStat.isSymbolicLink() ||
    resolve(supplied) !== directory ||
    realpathSync(directory) !== directory ||
    !privateMode(directoryStat.mode, 0o700)
  )
    fail('artifact directory is not canonical')
  const initPath = join(directory, INITIAL_NAME)
  const initRead = readBoundedFile(initPath, LIMITS.get(INITIAL_NAME))
  if (!privateMode(initRead.version.mode, 0o600)) fail('initialization permissions changed')
  const init = canonicalJson(initRead.bytes, true)
  const identity = { dev: String(directoryStat.dev), ino: String(directoryStat.ino) }
  if (
    !exactKeys(init, ['schema', 'sourceCommit', 'runId', 'runAttempt', 'target', 'nonce', 'directoryIdentity']) ||
    init.schema !== 'metis-persistence-policy-initialization/v1' ||
    !exactKeys(init.directoryIdentity, ['dev', 'ino']) ||
    !sameSnapshot(identity, init.directoryIdentity) ||
    init.sourceCommit !== process.env.GITHUB_SHA ||
    init.runId !== process.env.GITHUB_RUN_ID ||
    init.runAttempt !== Number(process.env.GITHUB_RUN_ATTEMPT) ||
    init.target !== process.env.PERSISTENCE_QA_POLICY_TARGET ||
    !/^[0-9a-f]{32}$/.test(init.nonce || '') ||
    init.nonce !== process.env.PERSISTENCE_QA_POLICY_NONCE
  )
    fail('initialization identity mismatch')
  if (
    !sameDirectory(statSync(realTemp, { bigint: true }), parentStat) ||
    String(lstatSync(supplied, { bigint: true }).ino) !== String(directoryStat.ino)
  )
    fail('initialization binding changed')
  return { root: realRoot, temp: realTemp, directory, parent: parentStat, identity, init, initRead }
}

function sameDirectory(left, right) {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  )
}

function privateMode(mode, expected) {
  return process.platform === 'win32' || (BigInt(mode) & 0o777n) === BigInt(expected)
}

function verifyOwner(bound) {
  const parent = statSync(bound.temp, { bigint: true })
  const dir = lstatSync(bound.directory, { bigint: true })
  if (
    lstatSync(bound.temp, { bigint: true }).isSymbolicLink() ||
    realpathSync(bound.temp) !== bound.temp ||
    !sameDirectory(parent, bound.parent) ||
    String(dir.dev) !== bound.identity.dev ||
    String(dir.ino) !== bound.identity.ino ||
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    !privateMode(dir.mode, 0o700) ||
    realpathSync(bound.directory) !== bound.directory ||
    !inside(bound.temp, bound.directory)
  )
    fail('artifact parent binding changed')
  const dirHandle = opendirSync(bound.directory, { bufferSize: 8 })
  const names = []
  let dirError
  let closeError
  try {
    for (let entry = dirHandle.readSync(); entry; entry = dirHandle.readSync()) {
      names.push(entry.name)
      if (names.length > 6 || !LIMITS.has(entry.name)) fail('artifact directory roster exceeded')
    }
  } catch (error) {
    dirError = error
  }
  try {
    dirHandle.closeSync()
  } catch (error) {
    closeError = error
  }
  if (dirError && closeError) throw new AggregateError([dirError, closeError], 'directory census and close failed')
  if (dirError) throw dirError
  if (closeError) throw closeError
  let total = 0
  for (const name of names) {
    const leaf = lstatSync(join(bound.directory, name), { bigint: true })
    const max = LIMITS.get(name)
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1n || leaf.size > BigInt(max))
      fail(`invalid artifact leaf ${name}`)
    total += Number(leaf.size)
  }
  if (total > 8 * 1024 * 1024) fail('artifact directory exceeds aggregate bound')
  return names
}

function writeOwnedArtifact(name, bytes, bound) {
  if (!LIMITS.has(name) || name === INITIAL_NAME || !Buffer.isBuffer(bytes) || bytes.byteLength > LIMITS.get(name))
    fail('artifact write outside fixed schema')
  verifyOwner(bound)
  const path = join(bound.directory, name)
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
    0o600
  )
  const version = withFd(fd, () => {
    completeWrite(fd, bytes)
    fsyncSync(fd)
    const held = fileSnapshot(fstatSync(fd, { bigint: true }))
    const named = fileSnapshot(lstatSync(path, { bigint: true }))
    if (!sameSnapshot(held, named) || named.nlink !== 1 || named.size !== bytes.length)
      fail('artifact write binding changed')
    return held
  })
  verifyOwner(bound)
  return { name, bytes: bytes.byteLength, sha256: sha(bytes), version }
}

function readOwnedArtifact(bound, name) {
  const max = LIMITS.get(name)
  verifyOwner(bound)
  const data = readBoundedFile(join(bound.directory, name), max)
  verifyOwner(bound)
  return data
}

function statusBytes(status) {
  const json = JSON.stringify(status)
  if (Buffer.byteLength(json) + 1 > LIMITS.get(STATUS_NAME)) fail('status artifact too large')
  return Buffer.from(`${json}\n`)
}

function workflowIdentity() {
  if (!validIdentity()) fail('workflow identity is missing or malformed')
  return {
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_WORKFLOW_SHA,
    runId: process.env.GITHUB_RUN_ID,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    target: process.env.PERSISTENCE_QA_POLICY_TARGET,
    path: '.github/workflows/persistence-qa-policy-contract.yml'
  }
}

function initialize() {
  const identity = workflowIdentity()
  const tempInput = process.env.RUNNER_TEMP
  if (!tempInput || !isAbsolute(tempInput)) fail('RUNNER_TEMP must be absolute')
  const temp = realpathSync(tempInput)
  if (lstatSync(tempInput, { bigint: true }).isSymbolicLink() || resolve(tempInput) !== temp)
    fail('RUNNER_TEMP must be canonical')
  const root = realpathSync(process.cwd())
  if (inside(root, temp) || temp === root) fail('RUNNER_TEMP must be outside checkout')
  const parent = statSync(temp, { bigint: true })
  const nonce = randomBytes(16).toString('hex')
  const directory = join(
    temp,
    `persistence-qa-policy-${identity.runId}-${identity.attempt}-${process.env.RUNNER_OS}-${nonce}`
  )
  mkdirSync(directory, { mode: 0o700 })
  const realDirectory = realpathSync(directory)
  if (
    !inside(temp, realDirectory) ||
    realDirectory !== directory ||
    !sameDirectory(statSync(temp, { bigint: true }), parent)
  )
    fail('new artifact directory is not canonical')
  const stat = lstatSync(realDirectory, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateMode(stat.mode, 0o700))
    fail('new artifact directory has invalid identity')
  const init = {
    schema: 'metis-persistence-policy-initialization/v1',
    sourceCommit: process.env.GITHUB_SHA,
    runId: identity.runId,
    runAttempt: identity.attempt,
    target: identity.target,
    nonce,
    directoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) }
  }
  const fd = openSync(
    join(directory, INITIAL_NAME),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600
  )
  const bytes = Buffer.from(`${JSON.stringify(init)}\n`)
  if (bytes.length > LIMITS.get(INITIAL_NAME)) fail('initialization exceeds bound')
  withFd(fd, () => {
    completeWrite(fd, bytes)
    fsyncSync(fd)
    const held = fileSnapshot(fstatSync(fd, { bigint: true }))
    const named = fileSnapshot(lstatSync(join(directory, INITIAL_NAME), { bigint: true }))
    if (!sameSnapshot(held, named) || held.size !== bytes.length || held.nlink !== 1 || !privateMode(held.mode, 0o600))
      fail('initialization publication changed')
  })
  if (
    !sameDirectory(statSync(temp, { bigint: true }), parent) ||
    String(lstatSync(directory, { bigint: true }).ino) !== String(stat.ino)
  )
    fail('initialization parent binding changed')
  process.env.PERSISTENCE_QA_POLICY_REPORT_DIR = directory
  process.env.PERSISTENCE_QA_POLICY_NONCE = nonce
  const initialOwner = owner()
  verifyOwner(initialOwner)
  if (process.env.GITHUB_ENV) {
    const envFd = openSync(process.env.GITHUB_ENV, 'a')
    withFd(envFd, () =>
      completeWrite(
        envFd,
        Buffer.from(`PERSISTENCE_QA_POLICY_REPORT_DIR=${directory}\nPERSISTENCE_QA_POLICY_NONCE=${nonce}\n`)
      )
    )
  }
  if (process.env.GITHUB_OUTPUT) {
    const outputFd = openSync(process.env.GITHUB_OUTPUT, 'a')
    withFd(outputFd, () => completeWrite(outputFd, Buffer.from(`path=${directory}\n`)))
  }
}

function digestPath(path, max = 1024 * 1024) {
  if (!/^[a-zA-Z0-9._@/-]+$/.test(path) || path.startsWith('/') || path.includes('..')) fail('noncanonical source path')
  const { bytes } = readBoundedFile(resolve(path), max)
  if (path === 'node_modules/vitest/package.json')
    installedVitestVersion = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).version
  return { path, bytes: bytes.byteLength, sha256: sha(bytes) }
}

function git(args, binary = false) {
  const result = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: binary ? 'buffer' : 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  })
  if (result.error || result.status !== 0) fail(`git source inspection failed: ${args[0]}`)
  return result.stdout
}

function collectChangedPaths(from, to) {
  return new TextDecoder('utf-8', { fatal: true })
    .decode(git(['diff', '--no-renames', '--name-only', '-z', '--diff-filter=ACDMRTUXB', from, to], true))
    .split('\0')
    .filter(Boolean)
    .sort()
}

function captureSource() {
  const head = git(['rev-parse', 'HEAD']).trim()
  if (!/^[0-9a-f]{40}$/.test(head) || process.env.GITHUB_SHA !== head) fail('checkout HEAD differs from workflow SHA')
  const status = git(['status', '--porcelain=v1', '--untracked-files=all'])
  if (status) fail('checkout is dirty')
  for (const ref of [BASELINE, P0_COMMIT]) {
    let commit
    try {
      commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim()
    } catch {
      git(['fetch', '--no-tags', '--depth=1', 'origin', ref])
      commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim()
    }
    if (commit !== ref) fail('fixed predecessor commit identity mismatch')
  }
  const headers = git(['cat-file', '-p', head]).split('\n\n', 1)[0].split('\n')
  const parents = headers.filter((line) => line.startsWith('parent ')).map((line) => line.slice(7))
  if (JSON.stringify(parents) !== JSON.stringify([P0_COMMIT])) fail('HEAD is not the direct P0 successor')
  const directPaths = collectChangedPaths(P0_COMMIT, head)
  if (JSON.stringify(directPaths) !== JSON.stringify(DIRECT_SUCCESSOR)) fail('direct successor path set changed')
  const changedPaths = collectChangedPaths(BASELINE, head)
  if (JSON.stringify(changedPaths) !== JSON.stringify(ALLOWED)) fail('cumulative source path set changed')
  const source = new Map()
  for (const [path, expected] of SOURCE_PINS) {
    const entry = digestPath(path)
    if (path === RUNNER_PATH) {
      const committed = git(['show', `HEAD:${RUNNER_PATH}`], true)
      if (committed.byteLength > 1024 * 1024 || sha(committed) !== entry.sha256)
        fail('runner source differs from committed blob')
    } else if (typeof expected !== 'string' || entry.sha256 !== expected)
      fail(`source differs from reviewed pin: ${path}`)
    source.set(path, entry)
  }
  for (const [path, expected] of API_SOURCE) {
    const entry = digestPath(path)
    if (entry.sha256 !== expected) fail(`installed Vitest source differs from reviewed API pin: ${path}`)
    source.set(path, entry)
  }
  const entries = [...source.values()].sort((a, b) => a.path.localeCompare(b.path))
  const requiredPaths = [...SOURCE_PINS.map(([path]) => path), ...API_SOURCE.map(([path]) => path)].sort((a, b) =>
    a.localeCompare(b)
  )
  if (JSON.stringify(entries.map((entry) => entry.path)) !== JSON.stringify(requiredPaths))
    fail('source inventory is incomplete or oversized')
  return { baseline: BASELINE, head, changedPaths, entries }
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  )
}

function p15Outcome(p15) {
  if (!validP15(p15) || p15.fixtureReady !== true || Object.values(p15.cleanup).some((value) => value !== true))
    return null
  const rows = p15.rows
  const malformed = rows.slice(0, 10)
  const controls = rows.slice(10)
  const enteredRows = rows.filter((row) => row.entered).length
  const terminalRows = rows.filter((row) => row.terminal).length
  const readerCalls = rows.reduce((sum, row) => sum + row.readerCalls, 0)
  const receipts = rows.filter((row) => row.receipt === 'opaque').length
  const resolverCalls = rows.reduce(
    (sum, row) => sum + Number(row.optional !== 'not-called') + Number(row.required !== 'not-called'),
    0
  )
  const resolverMismatches = malformed.reduce(
    (sum, row) => sum + Number(row.optional !== 'ENTERPRISE_INVALID') + Number(row.required !== 'ENTERPRISE_INVALID'),
    0
  )
  const controlsValid = controls.every((row, index) => {
    if (row.readerCalls !== 1 || row.readerArgs !== 'exact' || !row.entered || !row.terminal) return false
    if (index === 4 || index === 5)
      return (
        row.readerOutcome === 'rejected' &&
        row.receipt === 'none' &&
        row.optional === 'not-called' &&
        row.required === 'not-called' &&
        row.rejection === (index === 4 ? 'same-read-error' : 'same-close-error')
      )
    if (index === 2)
      return (
        row.readerOutcome === 'absent' &&
        row.receipt === 'opaque' &&
        row.optional === 'candidate' &&
        row.required === 'ENTERPRISE_REQUIRED' &&
        row.rejection === 'none'
      )
    if (index === 3)
      return (
        row.readerOutcome === 'invalid' &&
        row.receipt === 'opaque' &&
        row.optional === 'ENTERPRISE_INVALID' &&
        row.required === 'ENTERPRISE_INVALID' &&
        row.rejection === 'none'
      )
    if (index === 0 || index === 1)
      return (
        row.readerOutcome === 'present' &&
        row.receipt === 'opaque' &&
        row.optional === 'candidate' &&
        row.required === 'ENTERPRISE_REQUIRED' &&
        row.rejection === 'none'
      )
    return (
      row.readerOutcome === 'present' &&
      row.receipt === 'opaque' &&
      row.optional === 'ENTERPRISE_INVALID' &&
      row.required === 'ENTERPRISE_INVALID' &&
      row.rejection === 'none'
    )
  })
  const malformedAreInvalid = malformed.every(
    (row) =>
      row.readerCalls === 1 &&
      row.readerArgs === 'exact' &&
      row.entered &&
      row.terminal &&
      row.readerOutcome === 'present' &&
      row.receipt === 'opaque' &&
      row.optional === 'ENTERPRISE_INVALID' &&
      row.required === 'ENTERPRISE_INVALID' &&
      row.rejection === 'none'
  )
  if (
    enteredRows !== 18 ||
    terminalRows !== 18 ||
    readerCalls !== 18 ||
    receipts !== 16 ||
    resolverCalls !== 32 ||
    resolverMismatches !== 0 ||
    !controlsValid ||
    !malformedAreInvalid
  )
    return null
  return { enteredRows, terminalRows, readerCalls, receipts, resolverCalls }
}

function validateReporter(runtime, processResult, source, identity, raw) {
  const required = [
    'schema',
    'sourceCommit',
    'runId',
    'runAttempt',
    'target',
    'nonce',
    'vitestVersion',
    'reason',
    'apiValid',
    'unhandledErrors',
    'moduleErrors',
    'suiteErrors',
    'modules',
    'suites',
    'tests',
    'p15'
  ]
  if (
    !exactKeys(runtime, required) ||
    runtime.schema !== 'metis-persistence-policy-runtime/v1' ||
    runtime.sourceCommit !== source.head ||
    runtime.runId !== identity.runId ||
    runtime.runAttempt !== identity.attempt ||
    runtime.target !== identity.target ||
    runtime.nonce !== identity.nonce ||
    runtime.vitestVersion !== '4.1.11' ||
    runtime.apiValid !== true ||
    runtime.reason !== 'passed' ||
    runtime.unhandledErrors !== 0 ||
    runtime.moduleErrors !== 0 ||
    runtime.suiteErrors !== 0 ||
    runtime.modules !== 1 ||
    runtime.suites !== 1 ||
    !Array.isArray(runtime.tests) ||
    runtime.tests.length !== 15
  )
    return null
  if (JSON.stringify(runtime.tests.map((test) => test.title)) !== JSON.stringify(EXPECTED_TESTS)) return null
  const p15Counts = p15Outcome(runtime.p15)
  if (!p15Counts) return null
  for (const [index, test] of runtime.tests.entries()) {
    if (
      !exactKeys(test, [
        'title',
        'state',
        'retryCount',
        'repeatCount',
        'flaky',
        'durationMs',
        'startTime',
        'errorCount',
        'errorKind',
        'causalLabelMatched'
      ])
    )
      return null
    if (
      test.state !== 'passed' ||
      test.retryCount !== 0 ||
      test.repeatCount !== 0 ||
      test.flaky !== false ||
      !Number.isFinite(test.durationMs) ||
      test.durationMs < 0 ||
      !Number.isFinite(test.startTime) ||
      test.errorCount !== 0 ||
      test.errorKind !== 'none' ||
      test.causalLabelMatched !== false
    )
      return null
  }
  if (processResult.error !== 'none' || processResult.exitCode !== 0 || processResult.signal !== null) return null
  if (
    raw.success !== true ||
    raw.numTotalTests !== 15 ||
    raw.numPassedTests !== 15 ||
    raw.numFailedTests !== 0 ||
    raw.numPendingTests !== 0 ||
    raw.numTodoTests !== 0 ||
    raw.numTotalTestSuites !== 2 ||
    raw.numPassedTestSuites !== 2 ||
    raw.numFailedTestSuites !== 0 ||
    raw.numPendingTestSuites !== 0 ||
    !Array.isArray(raw.testResults) ||
    raw.testResults.length !== 1
  )
    return null
  const file = raw.testResults[0]
  if (
    !file ||
    file.status !== 'passed' ||
    file.name !== resolve(POLICY_TEST_FILE).replaceAll('\\', '/') ||
    !Array.isArray(file.assertionResults) ||
    file.assertionResults.length !== 15
  )
    return null
  for (const [index, test] of runtime.tests.entries()) {
    const assertion = file.assertionResults[index]
    if (
      !assertion ||
      assertion.title !== test.title ||
      assertion.fullName !== `persistence resource policy contracts ${test.title}` ||
      assertion.status !== 'passed' ||
      JSON.stringify(assertion.ancestorTitles) !== JSON.stringify(['persistence resource policy contracts']) ||
      !Array.isArray(assertion.failureMessages) ||
      assertion.failureMessages.length !== 0
    )
      return null
  }
  if (JSON.stringify(file.assertionResults[14].meta?.persistencePolicyP15) !== JSON.stringify(runtime.p15)) return null
  const expectedPlatform = { 'ubuntu-latest': 'linux', 'macos-latest': 'darwin', 'windows-latest': 'win32' }[
    identity.target
  ]
  const host = runtimeInfo()
  if (
    host.node !== 'v22.22.3' ||
    host.vitest !== '4.1.11' ||
    !['x64', 'arm64'].includes(host.arch) ||
    host.platform !== expectedPlatform ||
    runtime.p15.hostPlatform !== host.platform
  )
    return null
  return p15Counts
}

function runtimeInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    v8: process.versions.v8,
    modules: process.versions.modules,
    vitest: installedVitestVersion
  }
}

function verifyInputCensus(bound, versions) {
  const names = verifyOwner(bound).sort()
  if (JSON.stringify(names) !== JSON.stringify(EVIDENCE_NAMES)) fail('original input roster changed')
  for (const [name, version] of versions) {
    if (!sameSnapshot(version, fileSnapshot(lstatSync(join(bound.directory, name), { bigint: true }))))
      fail(`original input version changed: ${name}`)
  }
  if (versions.size !== 5) fail('original input census incomplete')
  verifyOwner(bound)
}

function validateStatus(status) {
  const keys = ['schema', 'state', 'phase', 'source', 'workflow', 'runtime', 'process', 'counts', 'evidence', 'witness']
  const sourceKeys = ['baseline', 'head', 'changedPaths', 'entries']
  const workflowKeys = ['repository', 'ref', 'sha', 'runId', 'attempt', 'path', 'target', 'nonce']
  const runtimeKeys = ['platform', 'arch', 'node', 'v8', 'modules', 'vitest']
  const countKeys = [
    'files',
    'recursiveSuites',
    'total',
    'passed',
    'failed',
    'pending',
    'todo',
    'skipped',
    'unhandledErrors',
    'moduleErrors',
    'suiteErrors'
  ]
  const expectedCounts = [1, 2, 15, 15, 0, 0, 0, 0, 0, 0, 0]
  if (
    !exactKeys(status, keys) ||
    status.schema !== 'metis-persistence-policy-stage/v1' ||
    status.state !== 'POLICY_ONLY_GREEN' ||
    status.phase !== PHASE ||
    !exactKeys(status.source, sourceKeys) ||
    status.source.baseline !== BASELINE ||
    !/^[0-9a-f]{40}$/.test(status.source.head) ||
    JSON.stringify(status.source.changedPaths) !== JSON.stringify(ALLOWED) ||
    !Array.isArray(status.source.entries) ||
    status.source.entries.length !== 27 ||
    !status.source.entries.every(
      (entry) =>
        exactKeys(entry, ['path', 'bytes', 'sha256']) &&
        typeof entry.path === 'string' &&
        !isAbsolute(entry.path) &&
        entry.path.length <= 240 &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        entry.bytes <= 1024 * 1024 &&
        /^[0-9a-f]{64}$/.test(entry.sha256)
    ) ||
    !exactKeys(status.workflow, workflowKeys) ||
    !validIdentity() ||
    status.workflow.sha !== process.env.GITHUB_WORKFLOW_SHA ||
    status.workflow.path !== '.github/workflows/persistence-qa-policy-contract.yml' ||
    !exactKeys(status.runtime, runtimeKeys) ||
    status.runtime.node !== 'v22.22.3' ||
    status.runtime.vitest !== '4.1.11' ||
    !exactKeys(status.process, ['exitCode', 'signal', 'error']) ||
    status.process.exitCode !== 0 ||
    status.process.signal !== null ||
    status.process.error !== 'none' ||
    !exactKeys(status.counts, countKeys) ||
    countKeys.some((key, index) => status.counts[key] !== expectedCounts[index]) ||
    !Array.isArray(status.evidence) ||
    status.evidence.length !== 5 ||
    JSON.stringify(status.evidence.map((item) => item.name)) !== JSON.stringify(EVIDENCE_NAMES) ||
    !status.evidence.every(
      (item) =>
        exactKeys(item, ['name', 'bytes', 'sha256']) &&
        Number.isSafeInteger(item.bytes) &&
        item.bytes >= 0 &&
        item.bytes <= LIMITS.get(item.name) &&
        /^[0-9a-f]{64}$/.test(item.sha256)
    ) ||
    !exactKeys(status.witness, ['p15', 'enteredRows', 'terminalRows', 'readerCalls', 'receipts', 'resolverCalls']) ||
    !p15Outcome(status.witness.p15) ||
    ['enteredRows', 'terminalRows', 'readerCalls', 'receipts', 'resolverCalls'].some(
      (key) => status.witness[key] !== p15Outcome(status.witness.p15)[key]
    )
  )
    fail('accepted status schema invalid')
}

function extractReports(stdout, nonce) {
  const runtimePrefix = Buffer.from('METIS_P15_RUNTIME_V1')
  const expectedFrame = Buffer.from(`METIS_P15_RUNTIME_V1 ${nonce} `)
  const rawPrefix = Buffer.from('{"numTotalTestSuites"')
  const expectedRaw = Buffer.from('{"numTotalTestSuites":')
  let rawBytes
  let runtimeBytes
  for (let start = 0; start < stdout.length; ) {
    const end = stdout.indexOf(10, start)
    const line = stdout.subarray(start, end < 0 ? stdout.length : end)
    if (line.subarray(0, runtimePrefix.length).equals(runtimePrefix)) {
      if (end < 0 || runtimeBytes || !line.subarray(0, expectedFrame.length).equals(expectedFrame))
        fail('runtime frame missing, duplicated or wrong nonce')
      const payload = line.subarray(expectedFrame.length)
      if (payload.length + 1 > LIMITS.get(RUNTIME_NAME)) fail('runtime frame exceeds bound')
      runtimeBytes = Buffer.concat([payload, Buffer.from('\n')])
    } else if (line.subarray(0, rawPrefix.length).equals(rawPrefix)) {
      if (
        end < 0 ||
        rawBytes ||
        line.length > LIMITS.get(RAW_NAME) ||
        !line.subarray(0, expectedRaw.length).equals(expectedRaw)
      )
        fail('raw JSON frame invalid')
      rawBytes = Buffer.from(line)
    }
    if (end < 0) break
    start = end + 1
  }
  if (!rawBytes || !runtimeBytes) fail('required observation frame missing')
  return { rawBytes, runtimeBytes }
}

function runValidation(bound) {
  const identity = workflowIdentity()
  const source = captureSource()
  const identityRecord = { ...identity, nonce: bound.init.nonce }
  const vitest = resolve('node_modules/vitest/vitest.mjs')
  if (process.env.METIS_CI_ROOT_REPORT) fail('unexpected root JSON output destination')
  const output = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      '--config',
      'vitest.config.ts',
      '--dangerouslyIgnoreUnhandledErrors=false',
      '--retry=0',
      '--reporter=json',
      '--reporter=' + resolve('scripts/qa/persistence-policy-reporter.mjs'),
      POLICY_TEST_FILE
    ],
    {
      cwd: bound.root,
      env: process.env,
      encoding: 'buffer',
      timeout: 20 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }
  )
  const processState = {
    exitCode: Number.isInteger(output.status) ? output.status : null,
    signal: typeof output.signal === 'string' ? output.signal : null,
    error: output.error
      ? output.error.code === 'ETIMEDOUT'
        ? 'timeout'
        : output.error.code === 'ENOBUFS'
          ? 'max-buffer'
          : 'spawn'
      : 'none'
  }
  lastProcessState = processState
  if (!Number.isSafeInteger(processState.exitCode) && processState.exitCode !== null) fail('invalid process exit')
  if (!Buffer.isBuffer(output.stdout) || !Buffer.isBuffer(output.stderr)) fail('missing process output buffer')
  const stdoutEvidence = writeOwnedArtifact(STDOUT_NAME, output.stdout, bound)
  const stderrEvidence = writeOwnedArtifact(STDERR_NAME, output.stderr, bound)
  if (
    processState.error !== 'none' ||
    processState.exitCode !== 0 ||
    processState.signal !== null ||
    output.stderr.length !== 0
  )
    fail('Vitest process did not terminate cleanly at policy GREEN')
  const { rawBytes, runtimeBytes } = extractReports(output.stdout, bound.init.nonce)
  const rawPublication = writeOwnedArtifact(RAW_NAME, rawBytes, bound)
  const runtimePublication = writeOwnedArtifact(RUNTIME_NAME, runtimeBytes, bound)
  const rawRead = readOwnedArtifact(bound, RAW_NAME)
  const runtimeRead = readOwnedArtifact(bound, RUNTIME_NAME)
  if (
    rawPublication.sha256 !== sha(rawRead.bytes) ||
    runtimePublication.sha256 !== sha(runtimeRead.bytes) ||
    !sameSnapshot(rawPublication.version, rawRead.version) ||
    !sameSnapshot(runtimePublication.version, runtimeRead.version)
  )
    fail('report publication readback changed')
  const raw = canonicalJson(rawRead.bytes, false)
  const observed = canonicalJson(runtimeRead.bytes, true)
  const p15 = validateReporter(observed, { ...processState }, source, identityRecord, raw)
  if (!p15) fail('P15 actual runtime evidence is not the exact policy GREEN')
  const evidenceByName = new Map([
    [RAW_NAME, { name: RAW_NAME, bytes: rawRead.bytes.byteLength, sha256: sha(rawRead.bytes) }],
    [RUNTIME_NAME, { name: RUNTIME_NAME, bytes: runtimeRead.bytes.byteLength, sha256: sha(runtimeRead.bytes) }],
    [STDOUT_NAME, { name: STDOUT_NAME, bytes: stdoutEvidence.bytes, sha256: stdoutEvidence.sha256 }],
    [STDERR_NAME, { name: STDERR_NAME, bytes: stderrEvidence.bytes, sha256: stderrEvidence.sha256 }],
    [INITIAL_NAME, { name: INITIAL_NAME, bytes: bound.initRead.bytes.byteLength, sha256: sha(bound.initRead.bytes) }]
  ])
  const evidence = EVIDENCE_NAMES.map((name) => evidenceByName.get(name))
  const status = {
    schema: 'metis-persistence-policy-stage/v1',
    state: 'POLICY_ONLY_GREEN',
    phase: PHASE,
    source,
    workflow: { ...identityRecord, sha: identity.sha },
    runtime: runtimeInfo(),
    process: processState,
    counts: {
      files: 1,
      recursiveSuites: 2,
      total: 15,
      passed: 15,
      failed: 0,
      pending: 0,
      todo: 0,
      skipped: 0,
      unhandledErrors: 0,
      moduleErrors: 0,
      suiteErrors: 0
    },
    evidence,
    witness: { p15: observed.p15, ...p15 }
  }
  validateStatus(status)
  verifyInputCensus(
    bound,
    new Map([
      [RAW_NAME, rawRead.version],
      [RUNTIME_NAME, runtimeRead.version],
      [STDOUT_NAME, stdoutEvidence.version],
      [STDERR_NAME, stderrEvidence.version],
      [INITIAL_NAME, bound.initRead.version]
    ])
  )
  return status
}

function blockedStatus(error) {
  const message = error instanceof Error ? error.message : ''
  const code = /timeout/i.test(message)
    ? 'timeout'
    : /source|git|checkout/i.test(message)
      ? 'source'
      : /Vitest|node_modules/i.test(message)
        ? 'dependency'
        : /artifact.*close/i.test(message)
          ? 'artifact-close'
          : /artifact|directory|parent|identity|binding/i.test(message)
            ? 'artifact-binding'
            : /bound|overflow/i.test(message)
              ? 'output-bound'
              : /reporter|JSON|frame/i.test(message)
                ? 'report-schema'
                : /roster|test/i.test(message)
                  ? 'test-roster'
                  : /fixture/i.test(message)
                    ? 'fixture'
                    : 'unexpected-result'
  return {
    schema: 'metis-persistence-policy-stage/v1',
    state: 'BLOCKED',
    phase: PHASE,
    code,
    sourceCommit: process.env.GITHUB_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: Number.isSafeInteger(Number(process.env.GITHUB_RUN_ATTEMPT))
      ? Number(process.env.GITHUB_RUN_ATTEMPT)
      : null,
    target: process.env.PERSISTENCE_QA_POLICY_TARGET || null,
    process: lastProcessState
  }
}

function failureInventory(failures) {
  const records = []
  for (const failure of failures) {
    const errors = failure instanceof AggregateError ? failure.errors.slice(0, 2) : [failure]
    for (const error of errors) {
      if (records.length === 4) return records
      records.push({
        name: error instanceof Error ? error.name.slice(0, 64) : 'unknown',
        code: typeof error?.code === 'string' ? error.code.slice(0, 64) : null,
        message: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256)
      })
    }
  }
  return records
}

function main() {
  const mode = process.argv[2]
  let bound
  let statusAttempted = false
  try {
    if (mode === 'initialize' && process.argv.length === 3) initialize()
    else if (mode === 'validate' && process.argv.length === 3) {
      bound = owner()
      const accepted = runValidation(bound)
      const bytes = statusBytes(accepted)
      statusAttempted = true
      writeOwnedArtifact(STATUS_NAME, bytes, bound)
    } else fail('use exactly one fixed runner mode')
  } catch (error) {
    const failures = [error]
    if (mode === 'validate' && bound && !statusAttempted) {
      try {
        const bytes = statusBytes(blockedStatus(error))
        statusAttempted = true
        writeOwnedArtifact(STATUS_NAME, bytes, bound)
      } catch (secondary) {
        failures.push(secondary)
      }
    }
    console.error(`Persistence policy evidence blocked: ${JSON.stringify(failureInventory(failures))}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
