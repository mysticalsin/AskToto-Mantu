import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
declare const __METIS_QA_IDENTITY__: boolean

const ROOT = process.cwd()
let OUT = ''
const NATIVE_BINARY = createRequire(resolve(ROOT, 'node_modules/esbuild/lib/main.js')).resolve(
  `@esbuild/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`
)
const LIMITS = Object.freeze({
  source: 64 * 1024,
  inputs: 128 * 1024,
  output: 256 * 1024,
  allOutputs: 8 * 1024 * 1024,
  modules: 32
})
const PROTOCOL = 'src/main/persistence/qa-run-protocol.ts'
const QA_IDENTITY = 'src/main/qa-identity.ts'
const RESOURCE = 'src/main/persistence/resource-policy-contract.ts'
const SUFFIX = '\nexport { validPayload as unsignedQaFixtureValidPayload }\n'
const LAUNCH_DOMAIN = Buffer.from('metis-persistence-qa-launch/v1\n', 'utf8')
const HEARTBEAT_DOMAIN = Buffer.from('metis-persistence-qa-heartbeat/v1\n', 'utf8')
const LAUNCH_SCHEMA = 'metis-persistence-qa-launch-envelope/v1'
const HEARTBEAT_SCHEMA = 'metis-persistence-qa-heartbeat/v1'
const MODES = ['windows-authenticode', 'windows-unsigned-candidate', 'mac-adhoc', 'mac-developer-id'] as const
type Mode = (typeof MODES)[number]
type Platform = 'win32' | 'darwin'
type Target = 'win32-x64' | 'darwin-x64' | 'darwin-arm64'
type RecordValue = Record<string, any>
declare module '@vitest/runner' {
  interface TaskMeta {
    qaU0Record?: RecordValue | null
    qaU0FixtureOwner?: FixtureOwner
  }
}
type FixtureOwner = {
  schema: 'metis-u0-fixture-owner/v2'
  mode: 'unadmitted' | 'dedicated' | 'ordinary-root'
  directory: string | null
  setup: 'pending' | 'complete' | 'failed'
  closing: boolean
  join: 'not-started' | 'pending' | 'fulfilled' | 'rejected'
  sameSetupPromise: boolean
  manifest: 'unpublished' | 'published' | 'failed'
  namespaces: number
  buildStarted: number
  buildFulfilled: number
  buildRejected: number
  outputOpened: number
  outputClosed: number
  compiledModules: number
  outputBytes: number
}
type FixtureModule = Record<string, (...args: any[]) => any> & { __fixture: FixtureInfo }
type FixtureInfo = {
  id: string
  target: Target
  mode: Mode
  stamp: boolean
  keyPem: string
  keyDer: string
  context: RecordValue
  runtime: RecordValue
  identity: RecordValue
  fields: RecordValue
  hashes: Record<string, string>
  publicModule: FixtureModule
  payloadModule: FixtureModule
  challenge: string
}

const sourceBytes = new Map<string, Buffer>()
const sourceHashes: Record<string, { gitBlob: string; gitSha256: string; checkoutSha256: string; lineEnding: string }> =
  {}
const bundles = new Map<string, FixtureInfo>()
const evidenceRows: RecordValue[] = []
const compiledArtifacts: RecordValue[] = []
let caseBytesTotal = 0
let totalOutputBytes = 0
let compiledModules = 0
let fixtureRoot = ''
let ownedIdentity:
  | {
      parent: { dev: number; ino: number }
      output: { dev: number; ino: number }
      compiled: { dev: number; ino: number }
    }
  | undefined
let currentCaseRecord: RecordValue | null = null
let setupPromise: Promise<void> | undefined
let beforeAllPromise: Promise<void> | undefined
let setupFailure: unknown
const owner: FixtureOwner = {
  schema: 'metis-u0-fixture-owner/v2',
  mode: 'unadmitted',
  directory: null,
  setup: 'pending',
  closing: false,
  join: 'not-started',
  sameSetupPromise: false,
  manifest: 'unpublished',
  namespaces: 0,
  buildStarted: 0,
  buildFulfilled: 0,
  buildRejected: 0,
  outputOpened: 0,
  outputClosed: 0,
  compiledModules: 0,
  outputBytes: 0
}
const DEDICATED = [
  'U0_DIR',
  'QA_U0_RUN_DIR',
  'QA_U0_CASE_REPORT',
  'QA_U0_VITEST_JSON',
  'QA_U0_TARGET',
  'QA_OWNER_FRAMEWORK_REPORT_PATH',
  'QA_OWNER_TARGET',
  'QA_OWNER_SOURCE_SHA'
] as const

function within(parent: string, child: string): boolean {
  const part = relative(parent, child)
  return (
    part !== '' &&
    part !== '..' &&
    !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(part)
  )
}
function realDirectory(path: string): string {
  const named = lstatSync(path)
  if (!named.isDirectory() || named.isSymbolicLink()) throw new Error('fixture-directory-substitution')
  return realpathSync(path)
}
function selectedOutput(): { mode: 'dedicated' | 'ordinary-root'; parent: string; basename: string } {
  const env = process.env
  const dedicated = Object.keys(env).some(
    (key) => DEDICATED.includes(key as (typeof DEDICATED)[number]) || key.startsWith('QA_U0_')
  )
  const fail = (label: string): never => {
    throw new Error(label)
  }
  const sane = (value: string | undefined, max = 1024): value is string =>
    typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max
  const temp = env.RUNNER_TEMP
  if (dedicated) {
    if (
      Object.keys(env).some(
        (key) => key.startsWith('QA_U0_') && !DEDICATED.includes(key as (typeof DEDICATED)[number])
      ) ||
      DEDICATED.some((key) => !Object.hasOwn(env, key) || !sane(env[key]))
    )
      fail('fixture-dedicated-context-incomplete')
    if (
      process.version !== 'v22.22.3' ||
      !sane(temp) ||
      !isAbsolute(temp) ||
      !sane(env.U0_DIR) ||
      !isAbsolute(env.U0_DIR) ||
      !sane(env.GITHUB_SHA, 40) ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) ||
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() !== env.GITHUB_SHA ||
      env.QA_OWNER_SOURCE_SHA !== env.GITHUB_SHA ||
      !['linux-shipping', 'windows-x64', 'macos-arm64'].includes(env.QA_U0_TARGET!) ||
      env.QA_U0_TARGET !==
        (process.platform === 'win32'
          ? 'windows-x64'
          : process.platform === 'darwin'
            ? 'macos-arm64'
            : 'linux-shipping') ||
      env.QA_OWNER_TARGET !== env.QA_U0_TARGET
    )
      fail('fixture-dedicated-context-incomplete')
    const root = realDirectory(temp!)
    const parent = realDirectory(env.U0_DIR!)
    if (
      !within(root, parent) ||
      ![
        [env.QA_U0_RUN_DIR!, 'fixture'],
        [env.QA_U0_CASE_REPORT!, 'cases.json'],
        [env.QA_U0_VITEST_JSON!, 'vitest.json'],
        [env.QA_OWNER_FRAMEWORK_REPORT_PATH!, 'framework.json']
      ].every(
        ([actual, name]) =>
          isAbsolute(actual) && basename(resolve(actual)) === name && realDirectory(dirname(resolve(actual))) === parent
      )
    )
      fail('fixture-dedicated-context-incomplete')
    return { mode: 'dedicated', parent, basename: 'fixture' }
  }
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    process.version !== 'v22.22.3' ||
    typeof __METIS_QA_IDENTITY__ === 'undefined' ||
    __METIS_QA_IDENTITY__ !== false ||
    !sane(env.GITHUB_SHA, 40) ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA) ||
    !sane(env.GITHUB_RUN_ID, 32) ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID) ||
    !Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) ||
    !sane(env.GITHUB_RUN_ATTEMPT, 16) ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT) ||
    !Number.isSafeInteger(Number(env.GITHUB_RUN_ATTEMPT)) ||
    !sane(env.GITHUB_REPOSITORY) ||
    !sane(env.GITHUB_JOB) ||
    !sane(env.GITHUB_WORKFLOW_REF) ||
    !sane(env.GITHUB_WORKSPACE) ||
    !sane(temp) ||
    !isAbsolute(temp) ||
    !sane(env.METIS_CI_ROOT_REPORT) ||
    !isAbsolute(env.METIS_CI_ROOT_REPORT) ||
    !env.METIS_CI_ROOT_REPORT.endsWith('.json') ||
    !sane(env.HOME) ||
    env.HOME !== env.USERPROFILE ||
    env.HOME !== env.METIS_TEST_HOME ||
    env.HOME !== env.ASKTOTO_TEST_SANDBOX_ROOT ||
    ![env.TMPDIR, env.TMP, env.TEMP].every((value) => value === join(env.HOME!, 'tmp')) ||
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() !== env.GITHUB_SHA
  )
    fail('fixture-root-context-incomplete')
  const workflow = env.GITHUB_WORKFLOW_REF
  if (
    !['build.yml', 'windows-unsigned-qa-mode.yml'].some((name) => {
      const prefix = `${env.GITHUB_REPOSITORY}/.github/workflows/${name}@`
      return workflow!.startsWith(prefix) && workflow!.length > prefix.length
    })
  )
    fail('fixture-root-context-incomplete')
  if (realpathSync(ROOT) !== realpathSync(env.GITHUB_WORKSPACE!)) fail('fixture-root-context-incomplete')
  const runner = realDirectory(temp!)
  const parent = realDirectory(dirname(env.METIS_CI_ROOT_REPORT!))
  if (
    !(runner === parent || within(runner, parent)) ||
    realDirectory(env.HOME!) === runner ||
    !within(realDirectory(env.HOME!), realDirectory(env.TMPDIR!))
  )
    fail('fixture-root-context-incomplete')
  return { mode: 'ordinary-root', parent, basename: `u0-root-${randomUUID()}` }
}

function sha(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as RecordValue
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
function digestRecord(label: string): string {
  return sha(`windows-unsigned-qa-source-fixture:${label}`)
}
function boundedSourceRead(path: string): Buffer {
  const absolute = resolve(ROOT, path)
  const named = lstatSync(absolute)
  if (!named.isFile() || named.isSymbolicLink() || named.size < 1 || named.size > LIMITS.source)
    throw new Error(`fixture-source-bound:${path}`)
  const fd = openSync(absolute, 'r')
  try {
    const held = fstatSync(fd)
    if (!held.isFile() || held.dev !== named.dev || held.ino !== named.ino || held.size !== named.size)
      throw new Error(`fixture-source-identity:${path}`)
    const bytes = Buffer.alloc(held.size)
    if (readSync(fd, bytes, 0, held.size, 0) !== held.size) throw new Error(`fixture-source-short-read:${path}`)
    const after = fstatSync(fd)
    const finalNamed = lstatSync(absolute)
    if (
      after.dev !== held.dev ||
      after.ino !== held.ino ||
      after.size !== held.size ||
      finalNamed.dev !== held.dev ||
      finalNamed.ino !== held.ino ||
      finalNamed.size !== held.size ||
      !finalNamed.isFile() ||
      finalNamed.isSymbolicLink()
    )
      throw new Error(`fixture-source-changed:${path}`)
    return bytes
  } finally {
    closeSync(fd)
  }
}
function source(path: string): Buffer {
  const existing = sourceBytes.get(path)
  if (existing) return existing
  const bytes = boundedSourceRead(path)
  const blob = execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: ROOT, encoding: 'utf8' }).trim()
  const gitBytes = execFileSync('git', ['show', `HEAD:${path}`], { cwd: ROOT, maxBuffer: LIMITS.source + 1 })
  if (gitBytes.byteLength > LIMITS.source || sha(gitBytes) !== sha(bytes)) {
    const gitText = gitBytes.toString('utf8')
    const checkoutText = bytes.toString('utf8')
    if (gitText.includes('\r\n') || !checkoutText.includes('\r\n') || checkoutText.replaceAll('\r\n', '\n') !== gitText)
      throw new Error(`checkout-source-mismatch:${path}`)
    sourceHashes[path] = {
      gitBlob: blob,
      gitSha256: sha(gitBytes),
      checkoutSha256: sha(bytes),
      lineEnding: 'git-lf-to-checkout-crlf'
    }
  } else
    sourceHashes[path] = {
      gitBlob: blob,
      gitSha256: sha(gitBytes),
      checkoutSha256: sha(bytes),
      lineEnding: 'identical'
    }
  sourceBytes.set(path, bytes)
  return bytes
}
function platformFor(target: Target): Platform {
  return target === 'win32-x64' ? 'win32' : 'darwin'
}
function fixtureStamp(target: Target, mode: Mode, keyDer: string, commit = process.env.GITHUB_SHA): RecordValue {
  if (
    !commit ||
    !process.env.GITHUB_REPOSITORY ||
    !process.env.GITHUB_WORKFLOW_REF ||
    !process.env.GITHUB_RUN_ID ||
    !process.env.GITHUB_RUN_ATTEMPT ||
    !process.env.GITHUB_JOB
  )
    throw new Error('fixture-github-context-missing')
  const platform = platformFor(target)
  const arch = target.endsWith('arm64') ? 'arm64' : 'x64'
  return {
    schema: 'metis-persistence-qa-build-stamp/v1',
    publicKeySpki: keyDer,
    context: {
      repository: process.env.GITHUB_REPOSITORY,
      workflowRef: process.env.GITHUB_WORKFLOW_REF,
      commit,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      job: process.env.GITHUB_JOB,
      target
    },
    candidateSha256: digestRecord(`candidate:${target}:${mode}`),
    implementationSha256: digestRecord('implementation'),
    profileMeasurementSha256: digestRecord('profile-measurement'),
    caseRosterSha256: digestRecord('case-roster'),
    runtime: {
      platform,
      arch,
      node: process.versions.node,
      electron: '0.0.0-source-fixture',
      v8: process.versions.v8,
      modules: process.versions.modules
    },
    qaIdentity: {
      runtimeName: 'asktoto-qa',
      bundleId: 'com.mantu.asktoto.qa',
      executableSha256: digestRecord('fixture-executable'),
      signingMode: mode
    }
  }
}
function compileLabel(target: Target, mode: Mode, group: string): string {
  return `${group}:${target}:${mode}`
}
function safeModuleName(id: string): string {
  return `u0-${sha(id)}.cjs`
}

function writeReport(path: string, bytes: Buffer, limit: number): void {
  if (bytes.byteLength < 2 || bytes.byteLength > limit) throw new Error('fixture-report-bound')
  if (owner.closing && owner.join !== 'fulfilled') throw new Error('fixture-report-closing')
  verifyOwned()
  const fd = openSync(path, 'wx+', 0o600)
  owner.outputOpened++
  let primary: unknown
  try {
    const held = fstatSync(fd)
    const named = lstatSync(path)
    if (
      !held.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      held.dev !== named.dev ||
      held.ino !== named.ino ||
      held.size !== 0 ||
      named.size !== 0
    )
      throw new Error('fixture-report-open-identity')
    let offset = 0
    while (offset < bytes.length) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count <= 0) throw new Error('fixture-report-short-write')
      offset += count
    }
    const copy = Buffer.alloc(bytes.length)
    offset = 0
    while (offset < copy.length) {
      const count = readSync(fd, copy, offset, copy.length - offset, offset)
      if (count <= 0) throw new Error('fixture-report-short-read')
      offset += count
    }
    if (!copy.equals(bytes) || readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0)
      throw new Error('fixture-report-readback')
    const after = fstatSync(fd)
    const namedAfter = lstatSync(path)
    if (
      after.dev !== held.dev ||
      after.ino !== held.ino ||
      after.size !== bytes.length ||
      namedAfter.dev !== held.dev ||
      namedAfter.ino !== held.ino ||
      namedAfter.size !== bytes.length ||
      namedAfter.isSymbolicLink()
    )
      throw new Error('fixture-report-final-identity')
  } catch (error) {
    primary = error
  }
  let closeError: unknown
  try {
    closeSync(fd)
    owner.outputClosed++
  } catch (error) {
    closeError = error
  }
  if (primary && closeError) throw new AggregateError([primary, closeError], 'fixture-report-and-close')
  if (primary) throw primary
  if (closeError) throw closeError
}

function verifyOwned(): void {
  if (!ownedIdentity || !OUT || !fixtureRoot) throw new Error('fixture-namespace-unowned')
  for (const [path, expected] of [
    [dirname(OUT), ownedIdentity.parent],
    [OUT, ownedIdentity.output],
    [fixtureRoot, ownedIdentity.compiled]
  ] as const) {
    const current = lstatSync(path)
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    )
      throw new Error('fixture-namespace-substituted')
  }
}

function exactJsonSize(value: unknown, limit: number, maxNodes: number): number {
  const seen = new Set<object>()
  let nodes = 0
  const scalar = (text: string): number => {
    if (Buffer.byteLength(text) > 8192) throw new Error('fixture-json-scalar-bound')
    return Buffer.byteLength(JSON.stringify(text))
  }
  const size = (item: unknown, depth: number): number => {
    if (++nodes > maxNodes || depth > 8) throw new Error('fixture-json-structure-bound')
    if (item === null) return 4
    if (typeof item === 'string') return scalar(item)
    if (typeof item === 'boolean') return item ? 4 : 5
    if (typeof item === 'number' && Number.isFinite(item)) return Buffer.byteLength(JSON.stringify(item))
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('fixture-json-value-bound')
    seen.add(item)
    let total = 2
    if (Array.isArray(item)) {
      if (item.length > 50) throw new Error('fixture-json-array-bound')
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(item, index)) throw new Error('fixture-json-hole')
        total += (index ? 1 : 0) + size(item[index], depth + 1)
      }
    } else {
      const keys = Object.keys(item)
      if (keys.length > 32) throw new Error('fixture-json-object-bound')
      for (const [index, key] of keys.entries()) {
        const property = Object.getOwnPropertyDescriptor(item, key)
        if (!property || !Object.hasOwn(property, 'value')) throw new Error('fixture-json-accessor')
        total += (index ? 1 : 0) + scalar(key) + 1 + size(property.value, depth + 1)
      }
    }
    seen.delete(item)
    if (total > limit) throw new Error('fixture-json-byte-bound')
    return total
  }
  return size(value, 0)
}

async function compileModule(
  id: string,
  stamp: RecordValue | null,
  exposePayload: boolean,
  sourcePath = PROTOCOL,
  overrideProtocol?: Buffer,
  identityBuild = stamp !== null
): Promise<{ module: FixtureModule; hashes: Record<string, string> }> {
  if (!OUT || owner.closing) throw new Error('fixture-compile-closing-or-unadmitted')
  if (compiledModules >= LIMITS.modules) throw new Error('fixture-module-bound')
  compiledModules += 1
  owner.compiledModules = compiledModules
  const protocol = overrideProtocol ?? source(sourcePath)
  const compiledProtocol = overrideProtocol ? Buffer.concat([protocol, Buffer.from(SUFFIX)]) : protocol
  const identity = source(QA_IDENTITY)
  const resource = source(RESOURCE)
  if (
    compiledProtocol.byteLength > LIMITS.source ||
    identity.byteLength > LIMITS.source ||
    resource.byteLength > LIMITS.source ||
    compiledProtocol.byteLength + identity.byteLength + resource.byteLength > LIMITS.inputs
  )
    throw new Error('fixture-input-bound')
  const stampText = stamp ? canonical(stamp) : ''
  const defines: Record<string, string> = {
    __METIS_QA_IDENTITY__: identityBuild ? 'true' : 'false',
    __METIS_QA_PERSISTENCE_BUILD_STAMP__: JSON.stringify(stampText)
  }
  const absProtocol = resolve(ROOT, PROTOCOL)
  const safeName = safeModuleName(id)
  if (owner.closing) throw new Error('fixture-compile-closing')
  verifyOwned()
  owner.buildStarted++
  let result: Awaited<ReturnType<typeof build>>
  try {
    const originalBuild = build({
      absWorkingDir: ROOT,
      entryPoints: overrideProtocol ? undefined : [absProtocol],
      stdin: overrideProtocol
        ? {
            contents: compiledProtocol.toString('utf8'),
            resolveDir: dirname(absProtocol),
            sourcefile: absProtocol,
            loader: 'ts'
          }
        : undefined,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      loader: { '.ts': 'ts' },
      write: false,
      metafile: true,
      sourcemap: false,
      outfile: resolve(fixtureRoot, safeName),
      define: defines,
      logLevel: 'silent'
    })
    result = await originalBuild
    owner.buildFulfilled++
  } catch (error) {
    owner.buildRejected++
    throw error
  }
  if (owner.closing) throw new Error('fixture-compile-closing')
  if (!result.metafile || !result.outputFiles) throw new Error('fixture-build-output-missing')
  const inputs = Object.keys(result.metafile.inputs)
    .map((path) => (isAbsolute(path) ? relative(ROOT, path) : path).replaceAll('\\', '/').replace(/^\.\//, ''))
    .sort()
  const expectedInputs = [PROTOCOL, QA_IDENTITY, RESOURCE].sort()
  if (inputs.length !== 3 || inputs.some((path, index) => path !== expectedInputs[index]))
    throw new Error(`fixture-input-graph:${inputs.join(',')}`)
  const outputs = result.outputFiles
  if (
    outputs.length !== 1 ||
    outputs[0].contents.byteLength < 1 ||
    outputs[0].contents.byteLength > LIMITS.output ||
    totalOutputBytes + outputs[0].contents.byteLength > LIMITS.allOutputs
  )
    throw new Error('fixture-output-bound')
  totalOutputBytes += outputs[0].contents.byteLength
  owner.outputBytes = totalOutputBytes
  const outPath = resolve(fixtureRoot, safeName)
  verifyOwned()
  const expectedOutput = outputs[0].contents
  const expectedOutputSha256 = sha(expectedOutput)
  const fd = openSync(outPath, 'wx+', 0o600)
  owner.outputOpened++
  let module: FixtureModule | undefined
  let finalBytes: Buffer | undefined
  let opened: ReturnType<typeof fstatSync> | undefined
  let primaryError: unknown
  let closeError: unknown
  let operationFailed = false
  let closeFailed = false
  let originalFdClosed = false
  let namedIdentityMatched = false
  const readOutput = (): Buffer => {
    const heldBefore = fstatSync(fd)
    const namedBefore = lstatSync(outPath)
    if (
      !opened ||
      !heldBefore.isFile() ||
      !namedBefore.isFile() ||
      namedBefore.isSymbolicLink() ||
      heldBefore.dev !== opened.dev ||
      heldBefore.ino !== opened.ino ||
      namedBefore.dev !== opened.dev ||
      namedBefore.ino !== opened.ino ||
      heldBefore.size !== expectedOutput.byteLength ||
      namedBefore.size !== expectedOutput.byteLength
    )
      throw new Error('fixture-output-identity-or-size')
    const bytes = Buffer.alloc(expectedOutput.byteLength)
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, offset)
      if (count <= 0) throw new Error('fixture-output-short-read')
      offset += count
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.byteLength) !== 0) throw new Error('fixture-output-trailing-bytes')
    const heldAfter = fstatSync(fd)
    const namedAfter = lstatSync(outPath)
    if (
      !heldAfter.isFile() ||
      !namedAfter.isFile() ||
      namedAfter.isSymbolicLink() ||
      heldAfter.dev !== opened.dev ||
      heldAfter.ino !== opened.ino ||
      namedAfter.dev !== opened.dev ||
      namedAfter.ino !== opened.ino ||
      heldAfter.size !== expectedOutput.byteLength ||
      namedAfter.size !== expectedOutput.byteLength
    )
      throw new Error('fixture-output-changed-during-readback')
    if (bytes.compare(expectedOutput) !== 0 || sha(bytes) !== expectedOutputSha256)
      throw new Error('fixture-output-readback-mismatch')
    namedIdentityMatched = true
    return bytes
  }
  try {
    opened = fstatSync(fd)
    const named = lstatSync(outPath)
    if (
      !opened.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino ||
      opened.size !== 0 ||
      named.size !== 0
    )
      throw new Error('fixture-output-open-identity')
    if (writeSync(fd, expectedOutput, 0, expectedOutput.byteLength, 0) !== expectedOutput.byteLength)
      throw new Error('fixture-short-write')
    readOutput()
    module = createRequire(import.meta.url)(outPath) as FixtureModule
    if (
      typeof module.hasCompiledQaPersistenceRunStamp !== 'function' ||
      typeof module.compiledQaPersistenceRunContext !== 'function' ||
      typeof module.newQaPersistenceBootChallenge !== 'function' ||
      typeof module.verifyQaPersistenceLaunchEnvelope !== 'function' ||
      typeof module.readVerifiedQaPersistenceLaunch !== 'function' ||
      typeof module.verifyQaPersistenceHeartbeat !== 'function' ||
      exposePayload !== (typeof module.unsignedQaFixtureValidPayload === 'function')
    )
      throw new Error('fixture-export-mismatch')
    finalBytes = readOutput()
  } catch (error) {
    primaryError = error
    operationFailed = true
  }
  try {
    closeSync(fd)
    originalFdClosed = true
    owner.outputClosed++
  } catch (error) {
    closeError = error
    closeFailed = true
  }
  if (operationFailed && closeFailed)
    throw new AggregateError([primaryError, closeError], 'fixture-output-failure-and-close-failure')
  if (operationFailed) throw primaryError
  if (closeFailed) throw closeError
  if (!module || !finalBytes || !originalFdClosed) throw new Error('fixture-output-custody-incomplete')
  const bytesOut = finalBytes
  const readback = {
    bytes: bytesOut.byteLength,
    sha256: sha(bytesOut),
    namedIdentityMatched,
    originalFdClosed
  }
  if (exactJsonSize(result.metafile, 64 * 1024 - 1, 8192) + 1 > 64 * 1024) throw new Error('fixture-metafile-bound')
  const metaBytes = Buffer.from(`${JSON.stringify(result.metafile)}\n`)
  if (metaBytes.byteLength < 2 || metaBytes.byteLength > 64 * 1024) throw new Error('fixture-metafile-bound')
  const metaPath = resolve(fixtureRoot, `${safeName}.meta.json`)
  writeReport(metaPath, metaBytes, 64 * 1024)
  const inputHashes = Object.fromEntries(inputs.map((path) => [path, sha(source(path))]))
  if (overrideProtocol && compiledProtocol.subarray(protocol.byteLength).compare(Buffer.from(SUFFIX)) !== 0)
    throw new Error('fixture-augmentation-mismatch')
  compiledArtifacts.push({
    id,
    file: safeName,
    metaFile: `${safeName}.meta.json`,
    privateInput: exposePayload,
    emitted: sha(bytesOut),
    emittedBytes: bytesOut.byteLength,
    readback,
    metafileSha256: sha(metaBytes),
    metafileBytes: metaBytes.byteLength,
    protocolInput: sha(compiledProtocol)
  })
  return {
    module,
    hashes: {
      ...inputHashes,
      artifactId: id,
      emitted: sha(bytesOut),
      emittedBytes: String(bytesOut.byteLength),
      protocolInput: sha(compiledProtocol),
      augmentationSuffix: overrideProtocol ? sha(SUFFIX) : '',
      outputGraph: sha(canonical(result.metafile.outputs))
    }
  }
}

async function prepare(
  target: Target,
  mode: Mode,
  group = 'matrix',
  stampOverride?: RecordValue | null
): Promise<FixtureInfo> {
  const id = compileLabel(target, mode, group)
  const cached = bundles.get(id)
  if (cached) return cached
  if (bundles.size + 2 > LIMITS.modules) throw new Error('fixture-module-bound')
  const pair = generateKeyPairSync('ed25519')
  const publicDer = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
  const stamp = stampOverride === undefined ? fixtureStamp(target, mode, publicDer) : stampOverride
  const keyPem = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const publicBuild = await compileModule(`${id}-public`, stamp, false)
  const privateBuild = await compileModule(`${id}-payload`, stamp, true, PROTOCOL, source(PROTOCOL))
  const fixture: FixtureInfo = {
    id,
    target,
    mode,
    stamp: stamp !== null,
    keyPem,
    keyDer: publicDer,
    context: stamp?.context ?? {},
    runtime: stamp?.runtime ?? {},
    identity: stamp?.qaIdentity ?? {},
    fields: stamp ?? {},
    hashes: {
      ...publicBuild.hashes,
      payloadArtifactId: privateBuild.hashes.artifactId,
      payloadProtocolInput: privateBuild.hashes.protocolInput,
      payloadAugmentationSuffix: privateBuild.hashes.augmentationSuffix,
      payloadOutput: privateBuild.hashes.emitted,
      payloadEmittedBytes: privateBuild.hashes.emittedBytes,
      payloadOutputGraph: privateBuild.hashes.outputGraph
    },
    publicModule: publicBuild.module,
    payloadModule: privateBuild.module,
    challenge: stamp
      ? publicBuild.module.newQaPersistenceBootChallenge()
      : 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  }
  bundles.set(id, fixture)
  return fixture
}

function payloadFor(f: FixtureInfo, overrides: RecordValue = {}): RecordValue {
  const now = Date.now()
  const platform = platformFor(f.target)
  const win = platform === 'win32'
  const parentPath = win ? 'C:\\qa-source-fixture' : '/tmp/metis-qa-source-fixture'
  const profilePath = win ? `${parentPath}\\profile` : `${parentPath}/profile`
  const owner = win ? 'S-1-5-21-111111111-222222222-333333333-1001' : '501'
  return {
    purpose: 'isolated-persistence-qualification',
    bootChallenge: f.challenge,
    sourceCommit: f.context.commit,
    buildContext: f.context,
    runId: f.context.runId,
    runGeneration: 1,
    candidateSha256: f.fields.candidateSha256 ?? digestRecord('candidate'),
    implementationSha256: f.fields.implementationSha256 ?? digestRecord('implementation'),
    profileMeasurementSha256: f.fields.profileMeasurementSha256 ?? digestRecord('profile-measurement'),
    caseRosterSha256: f.fields.caseRosterSha256 ?? digestRecord('case-roster'),
    runtime: f.runtime,
    qaIdentity: f.identity,
    allowedCases: ['before-show-refusal', 'status-no-side-effects'],
    notBefore: now - 1000,
    expiresAt: now + 60_000,
    profile: { path: profilePath, device: '1', inode: '2', birthtimeMs: 1000, owner, mode: 448 },
    parent: { path: parentPath, device: '1', inode: '1', birthtimeMs: 900, owner, mode: 448 },
    osPrincipalAssociation: win
      ? { platform: 'win32', sidAssociationSha256: digestRecord('principal') }
      : { platform: 'darwin', uid: 501, effectiveUid: 501 },
    nativeKeyIntent: { present: false, value: null },
    ...overrides
  }
}

function signPayload(f: FixtureInfo, payload: RecordValue, pem = f.keyPem, domain = LAUNCH_DOMAIN): Buffer {
  const payloadBytes = Buffer.from(f.payloadModule.qaPersistenceCanonical(payload), 'utf8')
  const signature = sign(null, Buffer.concat([domain, payloadBytes]), createPrivateKey(pem))
  return Buffer.from(
    f.payloadModule.qaPersistenceCanonical({
      schema: LAUNCH_SCHEMA,
      payload: payloadBytes.toString('base64url'),
      signature: signature.toString('base64url')
    }),
    'utf8'
  )
}
function launchResults(
  f: FixtureInfo,
  payload: RecordValue,
  expectedChallenge = f.challenge,
  key = f.keyPem
): { direct: boolean; launch: boolean; membership: boolean; forgedMembershipRefused: boolean } {
  const direct = f.payloadModule.unsignedQaFixtureValidPayload(payload)
  const verified = f.publicModule.verifyQaPersistenceLaunchEnvelope(
    signPayload(f, payload, key),
    expectedChallenge,
    Date.now()
  )
  const launch = verified !== null
  const membership = launch && f.publicModule.readVerifiedQaPersistenceLaunch(verified) !== null
  const forgedMembershipRefused = launch && f.publicModule.readVerifiedQaPersistenceLaunch(Object.freeze({})) === null
  return { direct, launch, membership, forgedMembershipRefused }
}
function stampResult(f: FixtureInfo): boolean {
  return f.publicModule.hasCompiledQaPersistenceRunStamp()
}
function record(
  id: string,
  observations: RecordValue,
  subcases: RecordValue[] = [],
  reached = 'reached',
  failurePhase: string | null = null
): void {
  if (subcases.length > 32 || evidenceRows.length >= 50) throw new Error('case-evidence-bound')
  const row = {
    id,
    observations,
    subcases,
    reached,
    failurePhase,
    hashes: {
      sourceReadSetSha256: sha(canonical(sourceHashes)),
      fixtureGraphSha256: sha(
        canonical([...bundles.values()].map((fixture) => ({ id: fixture.id, hashes: fixture.hashes })))
      )
    }
  }
  const bytes = exactJsonSize(row, 4096, 512)
  if (caseBytesTotal + bytes > 256 * 1024) throw new Error('case-evidence-bound')
  caseBytesTotal += bytes
  evidenceRows.push(row)
  currentCaseRecord = row
}
function assertAllFalse(results: boolean[], label: string): void {
  for (const [index, value] of results.entries()) expect(value, `${label}:${index}`).toBe(false)
}

const MATRIX: readonly { id: string; target: Target; mode: Mode; healthy: boolean }[] = [
  { id: 'U01', target: 'win32-x64', mode: 'windows-authenticode', healthy: true },
  { id: 'U02', target: 'win32-x64', mode: 'windows-unsigned-candidate', healthy: true },
  { id: 'U03', target: 'win32-x64', mode: 'mac-adhoc', healthy: false },
  { id: 'U04', target: 'win32-x64', mode: 'mac-developer-id', healthy: false },
  { id: 'U05', target: 'darwin-x64', mode: 'windows-authenticode', healthy: false },
  { id: 'U06', target: 'darwin-x64', mode: 'mac-adhoc', healthy: true },
  { id: 'U07', target: 'darwin-x64', mode: 'mac-developer-id', healthy: true },
  { id: 'U08', target: 'darwin-x64', mode: 'windows-unsigned-candidate', healthy: false },
  { id: 'U09', target: 'darwin-arm64', mode: 'windows-authenticode', healthy: false },
  { id: 'U10', target: 'darwin-arm64', mode: 'mac-adhoc', healthy: true },
  { id: 'U11', target: 'darwin-arm64', mode: 'mac-developer-id', healthy: true },
  { id: 'U12', target: 'darwin-arm64', mode: 'windows-unsigned-candidate', healthy: false }
]
const B_IDS = Array.from({ length: 13 }, (_, index) => `B${String(index + 1).padStart(2, '0')}`)
const H_IDS = ['H01', 'H02', 'H03'] as const
const CASE_IDS = [
  ...MATRIX.map((x) => x.id),
  ...B_IDS.flatMap((id) => [`${id}-authenticode-source-fixture`, `${id}-unsigned-source-fixture`]),
  'S01',
  'S02',
  'S03',
  'S04',
  ...H_IDS.flatMap((id) => [`${id}-authenticode-source-fixture`, `${id}-unsigned-source-fixture`]),
  'J01',
  'J02'
]

async function setupFixture(): Promise<void> {
  try {
    const selected = selectedOutput()
    const expectedName = selected.basename
    const directory = join(selected.parent, expectedName)
    const parentBefore = lstatSync(selected.parent)
    if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) throw new Error('fixture-parent-changed')
    const expectedBinary = resolve(
      ROOT,
      'node_modules',
      `@esbuild/${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'
    )
    if (process.env.ESBUILD_BINARY_PATH !== undefined || NATIVE_BINARY !== expectedBinary)
      throw new Error('fixture-esbuild-selection-mismatch')
    mkdirSync(directory, { recursive: false, mode: 0o700 })
    owner.namespaces++
    owner.mode = selected.mode
    owner.directory = expectedName
    const acquired = lstatSync(directory)
    const parentAfter = lstatSync(selected.parent)
    if (
      !acquired.isDirectory() ||
      acquired.isSymbolicLink() ||
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino ||
      !within(realDirectory(selected.parent), realDirectory(directory))
    )
      throw new Error('fixture-namespace-changed')
    OUT = directory
    if (!process.env.HOME) throw new Error('hermetic-fixture-home-missing')
    fixtureRoot = join(OUT, 'compiled')
    mkdirSync(fixtureRoot, { recursive: false, mode: 0o700 })
    ownedIdentity = {
      parent: { dev: parentAfter.dev, ino: parentAfter.ino },
      output: { dev: acquired.dev, ino: acquired.ino },
      compiled: { dev: lstatSync(fixtureRoot).dev, ino: lstatSync(fixtureRoot).ino }
    }
    source(PROTOCOL)
    source(QA_IDENTITY)
    source(RESOURCE)
    for (const item of MATRIX) await prepare(item.target, item.mode)
    // Four QA=false or missing-stamp controls.
    for (const [id, target, mode, stamp] of [
      ['S01', 'win32-x64', 'windows-authenticode', true],
      ['S02', 'win32-x64', 'windows-unsigned-candidate', true],
      ['S03', 'win32-x64', 'windows-authenticode', false],
      ['S04', 'win32-x64', 'windows-authenticode', false]
    ] as const) {
      const keyPair = generateKeyPairSync('ed25519')
      const pub = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
      const signedStamp = stamp ? fixtureStamp(target, mode, pub) : null
      const idKey = compileLabel(target, mode, id)
      const qaBuild = id === 'S04'
      const pair = await compileModule(`${idKey}-public`, signedStamp, false, PROTOCOL, undefined, qaBuild)
      const context = signedStamp?.context ?? {}
      let challenge = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      if (qaBuild) challenge = pair.module.newQaPersistenceBootChallenge()
      const keyPem = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
      bundles.set(id, {
        id,
        target,
        mode,
        stamp: Boolean(stamp),
        keyPem,
        keyDer: pub,
        context,
        runtime: signedStamp?.runtime ?? {},
        identity: signedStamp?.qaIdentity ?? {},
        fields: signedStamp ?? {},
        hashes: pair.hashes,
        publicModule: pair.module,
        payloadModule: pair.module,
        challenge
      })
    }
    // Two unknown-mode stamp bundles. These test the current closed enum and its post-repair boundary.
    for (const [id, target] of [
      ['J02-windows-unknown', 'win32-x64'],
      ['J02-darwin-unknown', 'darwin-x64']
    ] as const) {
      const mode = 'future-unknown-mode' as Mode
      const keyPair = generateKeyPairSync('ed25519')
      const pub = keyPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
      const stamp = fixtureStamp(target, target === 'win32-x64' ? 'windows-authenticode' : 'mac-adhoc', pub)
      stamp.qaIdentity.signingMode = mode
      const key = compileLabel(target, mode, id)
      const publicBuild = await compileModule(`${key}-public`, stamp, false)
      bundles.set(id, {
        id,
        target,
        mode,
        stamp: true,
        keyPem: keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
        keyDer: pub,
        context: stamp.context,
        runtime: stamp.runtime,
        identity: stamp.qaIdentity,
        fields: stamp,
        hashes: publicBuild.hashes,
        publicModule: publicBuild.module,
        payloadModule: publicBuild.module,
        challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
      })
    }
    // B04 coherent alternate Windows contexts under each tested mode; public-only bundles.
    for (const mode of ['windows-authenticode', 'windows-unsigned-candidate'] as const) {
      const target: Target = 'win32-x64'
      const base = bundles.get(compileLabel(target, mode, 'matrix'))!
      const altStamp = fixtureStamp(target, mode, base.keyDer, 'b'.repeat(40))
      const publicBuild = await compileModule(`B04-alt-${mode}`, altStamp, false)
      bundles.set(`B04-alt-${mode}`, {
        id: `B04-alt-${mode}`,
        target,
        mode,
        stamp: true,
        keyPem: base.keyPem,
        keyDer: base.keyDer,
        context: altStamp.context,
        runtime: altStamp.runtime,
        identity: altStamp.qaIdentity,
        fields: altStamp,
        hashes: publicBuild.hashes,
        publicModule: publicBuild.module,
        payloadModule: publicBuild.module,
        challenge: publicBuild.module.newQaPersistenceBootChallenge()
      })
    }
    if (compiledModules !== LIMITS.modules || bundles.size !== 20 || totalOutputBytes > LIMITS.allOutputs)
      throw new Error(`fixture-module-count:${compiledModules}`)
    owner.setup = 'complete'
  } catch (error) {
    owner.setup = 'failed'
    setupFailure = error
    throw error
  }
}

beforeAll(({}, suite) => {
  suite.meta.qaU0FixtureOwner = owner
  const original = setupFixture()
  setupPromise = original
  beforeAllPromise = original
  return original
})

afterEach(({ task }) => {
  task.meta.qaU0Record = currentCaseRecord
  currentCaseRecord = null
})

afterAll(async ({}, suite) => {
  owner.closing = true
  owner.sameSetupPromise = setupPromise !== undefined && setupPromise === beforeAllPromise
  owner.join = 'pending'
  try {
    if (!setupPromise) throw new Error('fixture-setup-promise-absent')
    await setupPromise
    owner.join = 'fulfilled'
  } catch (error) {
    owner.join = 'rejected'
    const expectedGuard =
      error instanceof Error &&
      ['fixture-dedicated-context-incomplete', 'fixture-root-context-incomplete'].includes(error.message) &&
      owner.mode === 'unadmitted' &&
      owner.directory === null &&
      owner.namespaces === 0 &&
      owner.buildStarted === 0 &&
      owner.outputOpened === 0
    if (error !== setupFailure || !expectedGuard) throw error
    return
  }
  if (suite.result?.hooks?.beforeAll !== 'pass') throw new Error('fixture-before-all-not-passed')
  if (
    owner.setup !== 'complete' ||
    !owner.sameSetupPromise ||
    owner.outputOpened !== 64 ||
    owner.outputClosed !== 64 ||
    owner.buildStarted !== 32 ||
    owner.buildFulfilled !== 32 ||
    owner.buildRejected !== 0
  )
    throw new Error('fixture-setup-incomplete')
  const manifest = {
    schema: 'metis-windows-unsigned-qa-source-fixture/v1',
    subject: 'synthetic-parser-fixture',
    sourceHead: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    job: process.env.GITHUB_JOB,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    compilerBinaryPath: NATIVE_BINARY,
    sourceHashes,
    compiledModules,
    artifacts: compiledArtifacts,
    modules: [...bundles.values()].map((f) => ({
      id: f.id,
      target: f.target,
      mode: f.mode,
      stampLiteralIncluded: f.stamp,
      context: f.context,
      runtime: f.runtime,
      identity: f.identity,
      hashes: f.hashes
    })),
    totalOutputBytes,
    cases: evidenceRows,
    owner: { mode: owner.mode, directory: owner.directory }
  }
  try {
    if (evidenceRows.length !== 50 || compiledArtifacts.length !== 32 || manifest.modules.length !== 20)
      throw new Error('fixture-manifest-count')
    if (exactJsonSize(manifest, 256 * 1024 - 1, 8192) + 1 > 256 * 1024) throw new Error('fixture-manifest-bound')
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`)
    writeReport(join(OUT, 'source-fixture.json'), bytes, 256 * 1024)
    owner.manifest = 'published'
  } catch (error) {
    owner.manifest = 'failed'
    throw error
  }
})

describe('windows unsigned QA mode finite source fixture', () => {
  for (const item of MATRIX)
    it(`${item.id} ${item.target} ${item.mode}`, async () => {
      const f = bundles.get(compileLabel(item.target, item.mode, 'matrix'))!
      const payload = payloadFor(f)
      const stamp = stampResult(f)
      const context = f.publicModule.compiledQaPersistenceRunContext() !== null
      const direct = f.payloadModule.unsignedQaFixtureValidPayload(payload)
      const verified = f.publicModule.verifyQaPersistenceLaunchEnvelope(signPayload(f, payload), f.challenge)
      const launch = verified !== null
      const membership = launch && f.publicModule.readVerifiedQaPersistenceLaunch(verified) !== null
      const forgedMembershipRefused =
        launch && f.publicModule.readVerifiedQaPersistenceLaunch(Object.freeze({})) === null
      const failurePhase =
        stamp !== item.healthy
          ? 'stamp'
          : direct !== item.healthy
            ? 'payload'
            : launch !== item.healthy
              ? 'envelope'
              : null
      record(
        item.id,
        { stamp, context, direct, launch, membership, forgedMembershipRefused, expectedHealthy: item.healthy },
        [],
        'reached',
        failurePhase
      )
      expect([stamp, direct, launch]).toEqual([item.healthy, item.healthy, item.healthy])
      expect(context).toBe(item.healthy)
      expect([membership, forgedMembershipRefused]).toEqual([item.healthy, item.healthy])
    })

  for (const id of B_IDS)
    for (const mode of ['windows-authenticode', 'windows-unsigned-candidate'] as const)
      it(`${id}-${mode === 'windows-authenticode' ? 'authenticode' : 'unsigned'}-source-fixture`, async () => {
        const target: Target = 'win32-x64'
        const f = bundles.get(compileLabel(target, mode, 'matrix'))!
        const caseId = `${id}-${mode === 'windows-authenticode' ? 'authenticode' : 'unsigned'}-source-fixture`
        const original = payloadFor(f)
        const positive = launchResults(f, original)
        const subcases: RecordValue[] = []
        if (!positive.direct || !positive.launch) {
          record(caseId, { positive }, subcases, 'prerequisite-refused', 'positive-launch')
          expect(positive).toEqual({ direct: true, launch: true, membership: true, forgedMembershipRefused: true })
          return
        }
        expect([positive.membership, positive.forgedMembershipRefused]).toEqual([true, true])
        const cases: Array<[string, RecordValue, string?, string?]> = []
        const changed = (key: string, value: unknown): RecordValue => ({ ...original, [key]: value })
        const c = original.buildContext
        const coherentDarwin = (target: 'darwin-x64' | 'darwin-arm64'): RecordValue => ({
          ...original,
          buildContext: { ...c, target },
          runtime: { ...original.runtime, platform: 'darwin', arch: target === 'darwin-x64' ? 'x64' : 'arm64' },
          qaIdentity: { ...original.qaIdentity, signingMode: 'mac-adhoc' },
          profile: { ...original.profile, path: '/tmp/metis-qa-source-fixture/profile', owner: '501' },
          parent: { ...original.parent, path: '/tmp/metis-qa-source-fixture', owner: '501' },
          osPrincipalAssociation: { platform: 'darwin', uid: 501, effectiveUid: 501 }
        })
        const contextMutations: Record<string, RecordValue> = {
          repository: {
            ...c,
            repository: 'other/Repository',
            workflowRef: 'other/Repository/.github/workflows/qa.yml@refs/heads/other'
          },
          workflowRef: { ...c, workflowRef: `${c.repository}/.github/workflows/other.yml@refs/heads/other` },
          job: { ...c, job: 'other-source-fixture-job' },
          node: { ...original.runtime, node: '22.22.2' },
          electron: { ...original.runtime, electron: '0.0.1-source-fixture' },
          v8: { ...original.runtime, v8: '12.4.1' },
          modules: { ...original.runtime, modules: '128' }
        }
        switch (id) {
          case 'B01':
            cases.push([
              'wrong-key',
              original,
              generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
            ])
            break
          case 'B02':
            cases.push([
              'wrong-challenge',
              original,
              undefined,
              f.challenge.replace(/^./, f.challenge[0] === 'A' ? 'B' : 'A')
            ])
            break
          case 'B03':
            cases.push(['source-commit', { ...original, sourceCommit: 'b'.repeat(40) }])
            break
          case 'B04': {
            const alt = bundles.get(`B04-alt-${mode}`)!
            const altPayload = {
              ...original,
              bootChallenge: f.challenge,
              sourceCommit: alt.context.commit,
              buildContext: alt.context,
              runtime: alt.runtime,
              qaIdentity: alt.identity
            }
            const altEnvelope = signPayload(alt, altPayload)
            const observed =
              alt.publicModule.verifyQaPersistenceLaunchEnvelope(altEnvelope, f.challenge, Date.now()) !== null
            const foreignOnFirst =
              f.publicModule.verifyQaPersistenceLaunchEnvelope(altEnvelope, f.challenge, Date.now()) !== null
            subcases.push({ id: 'alternate-self-consistent-context', direct: null, launch: observed, reached: true })
            subcases.push({ id: 'first-build-context-refusal', launch: foreignOnFirst, reached: true })
            record(caseId, { positive }, subcases, 'reached')
            expect(observed).toBe(true)
            assertAllFalse([foreignOnFirst], id)
            return
          }
          case 'B05': {
            const runId = '99000000000000000002'
            const bc = { ...c, runId }
            cases.push(['run-id', { ...original, runId, buildContext: bc }])
            break
          }
          case 'B06': {
            if (!Number.isSafeInteger(c.runAttempt) || c.runAttempt < 1) throw new Error('invalid-original-run-attempt')
            const otherAttempt = c.runAttempt === 1 ? 2 : 1
            if (otherAttempt === c.runAttempt) throw new Error('unchanged-run-attempt-control')
            cases.push(['run-attempt', { ...original, buildContext: { ...c, runAttempt: otherAttempt } }])
            break
          }
          case 'B07':
            for (const key of ['repository', 'workflowRef', 'job'] as const)
              cases.push([key, { ...original, buildContext: contextMutations[key] }])
            cases.push(['target', coherentDarwin('darwin-x64')])
            cases.push(['runtime-platform', { ...coherentDarwin('darwin-x64'), buildContext: c }])
            cases.push(['arch', coherentDarwin('darwin-arm64')])
            for (const key of ['node', 'electron', 'v8', 'modules'] as const)
              cases.push([key, { ...original, runtime: contextMutations[key] }])
            break
          case 'B08':
            cases.push(['candidate-hash', changed('candidateSha256', digestRecord('candidate-alternative'))])
            break
          case 'B09':
            cases.push([
              'implementation-hash',
              changed('implementationSha256', digestRecord('implementation-alternative'))
            ])
            break
          case 'B10':
            cases.push([
              'profile-measurement-hash',
              changed('profileMeasurementSha256', digestRecord('profile-measurement-alternative'))
            ])
            break
          case 'B11':
            cases.push(['case-roster-hash', changed('caseRosterSha256', digestRecord('case-roster-alternative'))])
            break
          case 'B12': {
            const options = mode === 'windows-authenticode' ? ['windows-unsigned-candidate'] : ['mac-developer-id']
            for (const value of [
              digestRecord('executable-alternative'),
              'other-qa-name',
              'com.mantu.other.qa',
              ...options
            ]) {
              const identity = { ...original.qaIdentity }
              if (value === 'other-qa-name') identity.runtimeName = value
              else if (value === 'com.mantu.other.qa') identity.bundleId = value
              else if (typeof value === 'string' && MODES.includes(value as Mode)) identity.signingMode = value
              else identity.executableSha256 = value
              cases.push([`identity-${cases.length + 1}`, { ...original, qaIdentity: identity }])
            }
            break
          }
          case 'B13': {
            for (const key of ['profile', 'parent', 'osPrincipalAssociation', 'nativeKeyIntent'] as const) {
              const payload = {
                ...original,
                [key]:
                  key === 'profile' || key === 'parent'
                    ? { ...original[key], inode: String(Number(original[key].inode) + 2) }
                    : key === 'osPrincipalAssociation'
                      ? platformFor(target) === 'win32'
                        ? { ...original[key], sidAssociationSha256: digestRecord('tampered') }
                        : { ...original[key], uid: 503, effectiveUid: 503 }
                      : { present: true, value: 'changed' }
              }
              const signed = signPayload(f, original)
              const outer = JSON.parse(signed.toString('utf8'))
              const decoded = JSON.parse(Buffer.from(outer.payload, 'base64url').toString('utf8'))
              decoded[key] = payload[key]
              outer.payload = Buffer.from(canonical(decoded)).toString('base64url')
              cases.push([key, original, undefined, undefined])
              subcases.push({
                id: key,
                direct: f.payloadModule.unsignedQaFixtureValidPayload(decoded),
                launch:
                  f.publicModule.verifyQaPersistenceLaunchEnvelope(Buffer.from(canonical(outer)), f.challenge) !== null,
                reached: true
              })
            }
            break
          }
        }
        if (id !== 'B13')
          for (const [label, payload, key, challenge] of cases) {
            const got = launchResults(f, payload, challenge, key)
            subcases.push({ id: label, direct: got.direct, launch: got.launch, reached: true })
          }
        record(caseId, { positive }, subcases, 'reached')
        if (id === 'B12')
          expect(subcases.map((row) => row.direct)).toEqual(
            mode === 'windows-authenticode' ? [true, false, false, true] : [true, false, false, false]
          )
        if (id !== 'B13')
          assertAllFalse(
            subcases.map((row) => row.launch),
            id
          )
        else
          assertAllFalse(
            subcases.map((row) => row.launch),
            id
          )
      })

  for (const id of ['S01', 'S02', 'S03', 'S04'] as const)
    it(`${id} shipping and missing-stamp boundary`, () => {
      const f = bundles.get(id)!
      const stamp = stampResult(f)
      const context = f.publicModule.compiledQaPersistenceRunContext() !== null
      let challengeError = false
      try {
        f.publicModule.newQaPersistenceBootChallenge()
      } catch (error) {
        challengeError = error instanceof Error && error.message === 'QA_RUN_NOT_QA_BUILD'
      }
      const payload = payloadFor(f)
      const launch = f.publicModule.verifyQaPersistenceLaunchEnvelope(signPayload(f, payload), f.challenge) !== null
      record(id, { stamp, context, launch, challengeError }, [], 'reached')
      expect(stamp).toBe(false)
      expect(launch).toBe(false)
      expect(context).toBe(false)
      if (id !== 'S04') expect(challengeError).toBe(true)
      else expect(challengeError).toBe(false)
    })

  for (const id of H_IDS)
    for (const mode of ['windows-authenticode', 'windows-unsigned-candidate'] as const)
      it(`${id}-${mode === 'windows-authenticode' ? 'authenticode' : 'unsigned'}-source-fixture`, () => {
        const f = bundles.get(compileLabel('win32-x64', mode, 'matrix'))!
        const payload = payloadFor(f)
        const direct = f.payloadModule.unsignedQaFixtureValidPayload(payload)
        const launch = f.publicModule.verifyQaPersistenceLaunchEnvelope(signPayload(f, payload), f.challenge)
        const positive = {
          direct,
          launch: launch !== null,
          membership: launch !== null && f.publicModule.readVerifiedQaPersistenceLaunch(launch) !== null,
          forgedMembershipRefused:
            launch !== null && f.publicModule.readVerifiedQaPersistenceLaunch(Object.freeze({})) === null
        }
        const subcases: RecordValue[] = []
        if (!launch) {
          record(
            `${id}-${mode === 'windows-authenticode' ? 'authenticode' : 'unsigned'}-source-fixture`,
            { positive },
            subcases,
            'prerequisite-refused',
            'positive-launch'
          )
          expect(launch).not.toBeNull()
          return
        }
        const now = Date.now()
        const makeHeartbeat = (
          sequence: number,
          issuedAt: number,
          keyPem = f.keyPem,
          domain = HEARTBEAT_DOMAIN,
          runId = payload.runId,
          generation = payload.runGeneration
        ): Buffer => {
          const unsigned = { schema: HEARTBEAT_SCHEMA, runId, runGeneration: generation, sequence, issuedAt }
          const signature = sign(
            null,
            Buffer.concat([domain, Buffer.from(canonical(unsigned))]),
            createPrivateKey(keyPem)
          )
          return Buffer.from(canonical({ ...unsigned, signature: signature.toString('base64url') }))
        }
        const observe = (id: string, bytes: Buffer, lastSeq = 0, lastMono = 10, wall = now, mono = 11): boolean => {
          const ok = f.publicModule.verifyQaPersistenceHeartbeat(bytes, launch, lastSeq, lastMono, wall, mono) !== null
          subcases.push({ id, accepted: ok, reached: true })
          return ok
        }
        let healthy: boolean[] = []
        if (id === 'H01') {
          const valid = makeHeartbeat(1, now)
          healthy = [
            observe('fresh-signed-heartbeat', valid),
            observe('duplicate-sequence', valid, 1),
            observe('lower-sequence', makeHeartbeat(1, now), 2)
          ]
        } else if (id === 'H02') {
          const wrong = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
          healthy = [
            observe('wrong-key', makeHeartbeat(1, now, wrong)),
            observe('wrong-domain', makeHeartbeat(1, now, f.keyPem, LAUNCH_DOMAIN)),
            observe('wrong-run', makeHeartbeat(1, now, f.keyPem, HEARTBEAT_DOMAIN, 'other-run')),
            observe('wrong-generation', makeHeartbeat(1, now, f.keyPem, HEARTBEAT_DOMAIN, payload.runId, 2))
          ]
        } else {
          healthy = [
            observe('fractional-monotonic', makeHeartbeat(1, now), 0, 10.25, now, 11.5),
            observe('backwards-monotonic', makeHeartbeat(1, now), 0, 12, now, 11),
            observe('nonfinite-monotonic', makeHeartbeat(1, now), 0, 10, now, Number.NaN),
            observe('heartbeat-age-boundary', makeHeartbeat(1, now), 0, 0, now, 30_000),
            observe('exact-launch-expiry', makeHeartbeat(1, payload.expiresAt), 0, 10, payload.expiresAt, 11)
          ]
        }
        record(
          `${id}-${mode === 'windows-authenticode' ? 'authenticode' : 'unsigned'}-source-fixture`,
          { positive },
          subcases,
          'reached'
        )
        expect(healthy[0]).toBe(id === 'H01' || id === 'H03')
        assertAllFalse(healthy.slice(id === 'H01' ? 1 : id === 'H02' ? 0 : 1), id)
      })

  it('J01 canonical source control and malformed envelope cases', () => {
    const f = bundles.get(compileLabel('win32-x64', 'windows-authenticode', 'matrix'))!
    const payload = payloadFor(f)
    const good = signPayload(f, payload)
    const challenge = f.challenge
    const goodFields = JSON.parse(good.toString('utf8')) as RecordValue
    const signedRaw = (payloadText: string): Buffer => {
      const payloadBytes = Buffer.from(payloadText, 'utf8')
      const signature = sign(null, Buffer.concat([LAUNCH_DOMAIN, payloadBytes]), createPrivateKey(f.keyPem))
      return Buffer.from(
        canonical({
          schema: LAUNCH_SCHEMA,
          payload: payloadBytes.toString('base64url'),
          signature: signature.toString('base64url')
        })
      )
    }
    const canonicalPayload = canonical(payload)
    const duplicate = Buffer.from(
      `{"schema":${JSON.stringify(LAUNCH_SCHEMA)},"schema":${JSON.stringify(LAUNCH_SCHEMA)},"payload":${JSON.stringify(goodFields.payload)},"signature":${JSON.stringify(goodFields.signature)}}`
    )
    const invalidUtf8 = Buffer.from([0xc3, 0x28])
    const duplicatedPayload = canonicalPayload.replace(
      '"purpose":"isolated-persistence-qualification"',
      '"purpose":"isolated-persistence-qualification","purpose":"isolated-persistence-qualification"'
    )
    if (duplicatedPayload === canonicalPayload) throw new Error('duplicate-payload-fixture-missing-key')
    const deepEnvelope = signedRaw(
      canonical({ ...payload, depthProbe: Array.from({ length: 18 }).reduce((value) => [value], 0 as unknown) })
    )
    const overBound = Buffer.concat([Buffer.alloc(65_537 - good.byteLength, 0x20), good])
    const cases: Array<[string, Buffer]> = [
      ['duplicate-outer-key', duplicate],
      ['invalid-utf8', invalidUtf8],
      [
        'noncanonical-base64url',
        Buffer.from(good.toString().replace(/"payload":"([^"]+)"/, (_m, p: string) => `"payload":"${p}="`))
      ],
      ['noncanonical-payload', signedRaw(` ${canonicalPayload} `)],
      ['duplicate-payload-key', signedRaw(duplicatedPayload)],
      ['over-bound', overBound],
      ['over-depth', deepEnvelope],
      ['truncated', Buffer.from('{"schema":"metis-persistence-qa-launch-envelope/v1","payload":"e30","signature":"AA"')]
    ]
    const subcases = cases.map(([id, bytes]) => ({
      id,
      accepted: f.publicModule.verifyQaPersistenceLaunchEnvelope(bytes, challenge) !== null,
      boundary:
        id === 'over-depth'
          ? 'depth-plus-payload-schema'
          : id === 'invalid-utf8'
            ? 'utf8-before-signature'
            : id === 'truncated'
              ? 'json-before-signature'
              : 'isolated-parser-or-bound',
      reached: true
    }))
    const canonicalControl = f.publicModule.verifyQaPersistenceLaunchEnvelope(good, challenge) !== null
    record('J01', { canonicalControl }, subcases, 'reached')
    expect(canonicalControl).toBe(true)
    assertAllFalse(
      subcases.map((row) => row.accepted),
      'J01'
    )
  })

  it('J02 unknown stamp and payload modes refuse without borrowing a valid stamp', () => {
    const windowsUnknown = bundles.get('J02-windows-unknown')!
    const darwinUnknown = bundles.get('J02-darwin-unknown')!
    const good = bundles.get(compileLabel('win32-x64', 'windows-authenticode', 'matrix'))!
    const unknownPayload = { ...payloadFor(good), qaIdentity: { ...good.identity, signingMode: 'future-unknown-mode' } }
    const stampUnknown = stampResult(windowsUnknown)
    const darwinStampUnknown = stampResult(darwinUnknown)
    const payloadUnknown = good.payloadModule.unsignedQaFixtureValidPayload(unknownPayload)
    const borrowed =
      good.publicModule.verifyQaPersistenceLaunchEnvelope(signPayload(good, unknownPayload), good.challenge) !== null
    record('J02', { stampUnknown, darwinStampUnknown, payloadUnknown, borrowed }, [], 'reached')
    expect(stampUnknown).toBe(false)
    expect(darwinStampUnknown).toBe(false)
    expect(payloadUnknown).toBe(false)
    expect(borrowed).toBe(false)
  })
})

export const windowsUnsignedQaCaseRoster = CASE_IDS
