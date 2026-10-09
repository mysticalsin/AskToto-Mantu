#!/usr/bin/env node
/**
 * Static verification of the native ZIP built earlier in this same hosted job. This is not a general
 * hostile-archive extractor, a native runtime test or a release publisher. Native tool output stays
 * captured; only a closed report and the unchanged ZIP may leave the job.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = 'metis.native-package-baseline.v1'
const BUNDLE_ID = 'com.mantu.metis.native'
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/
const SHA = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
const NUMBER = /^[1-9][0-9]*$/
const CHILDREN = ['output', 'inspection', 'report']
const FAILURES = new Set([
  'HOSTED_MAC_REQUIRED',
  'SOURCE_IDENTITY_INVALID',
  'BUNDLE_IDENTITY_INVALID',
  'VERSION_INVALID',
  'MODE_INVALID',
  'WORKFLOW_OUTPUT_REQUIRED',
  'WORKFLOW_OUTPUT_INVALID',
  'WORKSPACE_INPUT_INVALID',
  'WORKSPACE_RECEIPT_INVALID',
  'WORKSPACE_PARENT_INVALID',
  'OWNED_DIRECTORY_INVALID',
  'REGULAR_FILE_REQUIRED',
  'INSPECTION_NOT_EMPTY',
  'PACKAGE_INVENTORY_INVALID',
  'ARCHIVE_INTEGRITY_FAILED',
  'ARCHIVE_LIST_FAILED',
  'ARCHIVE_ENTRIES_INVALID',
  'ARCHIVE_EXTRACTION_FAILED',
  'EXTRACTED_ROOT_INVALID',
  'BUNDLE_GRAPH_INVALID',
  'RESOURCE_GRAPH_INVALID',
  'BUNDLE_PLIST_INVALID',
  'EXECUTABLE_OUTSIDE_APP',
  'SIGNATURE_INTEGRITY_FAILED',
  'SIGNATURE_MODE_INVALID',
  'SLICES_INVALID',
  'PACKAGE_CHANGED',
  'NATIVE_PACKAGE_VERIFICATION_FAILED',
  'NATIVE_PACKAGE_INSPECTION_CLEANUP_FAILED'
])
const CHECKS = Object.freeze({
  archive_integrity: 'PASS',
  bundle_graph: 'PASS',
  bundle_identity: 'PASS',
  signature_integrity: 'PASS',
  architecture_policy: 'NOT_EVALUATED',
  runtime: 'NOT_EVALUATED'
})

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}

const matches = (value, pattern) => typeof value === 'string' && pattern.test(value)
const validVersion = (value) => matches(value, VERSION) && value.length <= 80
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function closedFailure(error) {
  return error instanceof Error && FAILURES.has(error.message) ? error.message : 'NATIVE_PACKAGE_VERIFICATION_FAILED'
}

function sourceValid(source) {
  return (
    exactKeys(source, ['sha', 'run_id', 'run_attempt']) &&
    matches(source.sha, SHA) &&
    matches(source.run_id, NUMBER) &&
    matches(source.run_attempt, NUMBER)
  )
}

function contained(root, target) {
  const suffix = relative(root, target)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

function entryKey(path) {
  return path.normalize('NFC').toLowerCase()
}

function safeRelative(path, allowRoot = false) {
  return (
    typeof path === 'string' &&
    (allowRoot && path === ''
      ? true
      : path.length > 0 &&
        !/^[A-Za-z]:/.test(path) &&
        !/[\\\u0000-\u001f\u007f]/.test(path) &&
        !path.startsWith('/') &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
  )
}

/** Entry names come only from captured unzip -Z1 after unzip -tqq passed on this job's own ZIP. */
export function archiveEntryProblems(entries) {
  const problems = new Set()
  const seen = new Set()
  let appSeen = false
  if (!Array.isArray(entries)) return ['ARCHIVE_ENTRIES_INVALID']
  for (const entry of entries) {
    const path = typeof entry === 'string' ? entry.replace(/\/$/, '') : null
    if (!safeRelative(path)) {
      problems.add('ARCHIVE_ENTRY_INVALID')
      continue
    }
    const app = path === 'Metis.app' || path.startsWith('Metis.app/')
    const metadata = path === '__MACOSX' || path === '__MACOSX/Metis.app' || path.startsWith('__MACOSX/Metis.app/')
    if (!app && !metadata) problems.add('ARCHIVE_ENTRY_OUTSIDE_APP')
    appSeen ||= app
    const key = entryKey(path)
    if (seen.has(key)) problems.add('ARCHIVE_ENTRY_ALIAS')
    seen.add(key)
  }
  if (!appSeen) problems.add('ARCHIVE_APP_MISSING')
  return [...problems]
}

/** Records are collected by lstat-only traversal. resolved is realpath made relative to the app root. */
export function bundleGraphProblems(records) {
  if (!Array.isArray(records)) return ['BUNDLE_GRAPH_INVALID']
  const problems = new Set()
  const byPath = new Map()
  const aliases = new Set()
  for (const record of records) {
    if (!record || !safeRelative(record.path, true)) {
      problems.add('BUNDLE_ENTRY_INVALID')
      continue
    }
    const key = entryKey(record.path)
    if (aliases.has(key)) problems.add('BUNDLE_ENTRY_ALIAS')
    aliases.add(key)
    byPath.set(record.path, record)
    if (!['directory', 'file', 'symlink'].includes(record.kind)) problems.add('BUNDLE_ENTRY_KIND_INVALID')
    if (record.kind !== 'directory' && record.nlink !== 1) problems.add('BUNDLE_HARDLINK_INVALID')
  }
  if (byPath.get('')?.kind !== 'directory') problems.add('BUNDLE_ROOT_INVALID')
  for (const record of byPath.values()) {
    if (record.path !== '') {
      const parent = posix.dirname(record.path)
      if (byPath.get(parent === '.' ? '' : parent)?.kind !== 'directory') {
        problems.add('BUNDLE_PARENT_INVALID')
      }
    }
    if (record.kind !== 'symlink') continue
    const parts = record.path.split('/')
    const framework = parts.slice(0, 3).join('/')
    if (
      parts.length < 4 ||
      parts[0] !== 'Contents' ||
      parts[1] !== 'Frameworks' ||
      !/^[^/]+\.framework$/.test(parts[2]) ||
      byPath.get(framework)?.kind !== 'directory' ||
      typeof record.target !== 'string' ||
      record.target.length === 0 ||
      /[\\\u0000-\u001f\u007f]/.test(record.target) ||
      posix.isAbsolute(record.target) ||
      /^[A-Za-z]:/.test(record.target) ||
      !safeRelative(record.resolved)
    ) {
      problems.add('BUNDLE_LINK_INVALID')
      continue
    }
    const lexical = posix.normalize(posix.join(posix.dirname(record.path), record.target))
    const inside = (path) => path === framework || path.startsWith(`${framework}/`)
    const target = byPath.get(record.resolved)
    if (
      !inside(lexical) ||
      !inside(record.resolved) ||
      !target ||
      !['file', 'directory'].includes(target.kind) ||
      record.path === record.resolved ||
      record.path.startsWith(`${record.resolved}/`)
    ) {
      problems.add('BUNDLE_LINK_INVALID')
    }
  }
  return [...problems]
}

export function nativeIdentityProblems({ source, checkoutSha, expectedVersion, bundle }) {
  const problems = []
  if (!sourceValid(source) || source.sha !== checkoutSha) problems.push('SOURCE_IDENTITY_INVALID')
  if (
    !validVersion(expectedVersion) ||
    !exactKeys(bundle, ['id', 'version', 'build', 'executable']) ||
    bundle.id !== BUNDLE_ID ||
    bundle.version !== expectedVersion ||
    !matches(bundle.build, /^\d+(?:\.\d+){0,2}$/) ||
    bundle.build.length > 30 ||
    !matches(bundle.executable, /^[A-Za-z0-9][A-Za-z0-9._-]*$/) ||
    bundle.executable.length > 100
  ) {
    problems.push('BUNDLE_IDENTITY_INVALID')
  }
  return problems
}

export function parseMeasuredSlices(text) {
  const slices = typeof text === 'string' ? text.trim().split(/\s+/) : []
  if (
    slices.length === 0 ||
    slices.some((slice) => !['arm64', 'x86_64'].includes(slice)) ||
    new Set(slices).size !== slices.length
  ) {
    throw new Error('SLICES_INVALID')
  }
  return slices.sort()
}

export function parseAdHocSignature(text) {
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : []
  const signatures = lines.filter((line) => line.startsWith('Signature='))
  if (
    signatures.length !== 1 ||
    signatures[0] !== 'Signature=adhoc' ||
    lines.some((line) => line.startsWith('Authority='))
  ) {
    throw new Error('SIGNATURE_MODE_INVALID')
  }
  return 'AD_HOC'
}

export function reportProblems(report) {
  const problems = []
  if (!exactKeys(report, ['schema', 'source', 'asset', 'bundle', 'slices', 'signature', 'checks'])) {
    return ['REPORT_KEYS_INVALID']
  }
  if (report.schema !== SCHEMA || !sourceValid(report.source)) problems.push('REPORT_SOURCE_INVALID')
  if (
    !exactKeys(report.bundle, ['id', 'version', 'build']) ||
    report.bundle.id !== BUNDLE_ID ||
    !validVersion(report.bundle.version) ||
    !matches(report.bundle.build, /^\d+(?:\.\d+){0,2}$/) ||
    report.bundle.build.length > 30
  ) {
    problems.push('REPORT_BUNDLE_INVALID')
  }
  if (
    !exactKeys(report.asset, ['filename', 'bytes', 'sha256']) ||
    report.asset.filename !== `Metis-Native-${report.bundle?.version}.zip` ||
    !Number.isSafeInteger(report.asset.bytes) ||
    report.asset.bytes <= 0 ||
    !matches(report.asset.sha256, HASH)
  ) {
    problems.push('REPORT_ASSET_INVALID')
  }
  if (
    !Array.isArray(report.slices) ||
    report.slices.length === 0 ||
    report.slices.some((slice) => !['arm64', 'x86_64'].includes(slice)) ||
    new Set(report.slices).size !== report.slices.length
  ) {
    problems.push('REPORT_SLICES_INVALID')
  }
  if (report.signature !== 'AD_HOC') problems.push('REPORT_SIGNATURE_INVALID')
  if (
    !exactKeys(report.checks, Object.keys(CHECKS)) ||
    Object.entries(CHECKS).some(([k, v]) => report.checks[k] !== v)
  ) {
    problems.push('REPORT_CHECKS_INVALID')
  }
  return problems
}

/** Called only after archive, graph and codesign verification; tests supply synthetic measurements. */
export function buildNativeReport(input) {
  const identity = nativeIdentityProblems(input)
  if (identity.length) throw new Error(identity.join(','))
  const report = {
    schema: SCHEMA,
    source: { sha: input.source.sha, run_id: input.source.run_id, run_attempt: input.source.run_attempt },
    asset: { filename: input.asset.filename, bytes: input.asset.bytes, sha256: input.asset.sha256 },
    bundle: { id: input.bundle.id, version: input.bundle.version, build: input.bundle.build },
    slices: [...input.slices].sort(),
    signature: input.signature,
    checks: { ...CHECKS }
  }
  const problems = reportProblems(report)
  if (problems.length) throw new Error(problems.join(','))
  return report
}

function realDirectory(path) {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error('OWNED_DIRECTORY_INVALID')
  }
  return info
}

/** Allocate, never reuse, the output/inspection/report directories for one same-job build. */
export function allocateWorkspace(runnerTemp, source) {
  if (!sourceValid(source) || typeof runnerTemp !== 'string' || !isAbsolute(runnerTemp)) {
    throw new Error('WORKSPACE_INPUT_INVALID')
  }
  const parent = realpathSync(runnerTemp)
  realDirectory(parent)
  const root = mkdtempSync(join(parent, 'metis-native-package-'))
  const info = realDirectory(root)
  try {
    for (const child of CHILDREN) mkdirSync(join(root, child), { mode: 0o700 })
    const directories = Object.fromEntries(
      ['', ...CHILDREN].map((child) => {
        const entry = realDirectory(join(root, child))
        return [child || 'root', { dev: entry.dev, ino: entry.ino }]
      })
    )
    const bytes = JSON.stringify({ source, directories })
    writeFileSync(join(root, 'ownership.json'), bytes, { flag: 'wx', mode: 0o600 })
    return { root, ownerDigest: digest(bytes) }
  } catch (error) {
    // This invocation has the original mkdtemp receipt; no caller-selected directory can reach here.
    const current = realDirectory(root)
    if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('WORKSPACE_RECEIPT_INVALID')
    rmSync(root, { recursive: true })
    throw error
  }
}

/** A later job step must present the allocation receipt, source/run identity and unchanged real root. */
export function verifyOwnedWorkspace(workspace, runnerTemp, source) {
  if (
    !exactKeys(workspace, ['root', 'ownerDigest']) ||
    typeof workspace.root !== 'string' ||
    !isAbsolute(workspace.root) ||
    !matches(workspace.ownerDigest, HASH) ||
    !sourceValid(source) ||
    typeof runnerTemp !== 'string' ||
    !isAbsolute(runnerTemp)
  ) {
    throw new Error('WORKSPACE_RECEIPT_INVALID')
  }
  const parent = realpathSync(runnerTemp)
  realDirectory(parent)
  const { root } = workspace
  if (dirname(root) !== parent || !/^metis-native-package-[A-Za-z0-9]{6}$/.test(basename(root))) {
    throw new Error('WORKSPACE_PARENT_INVALID')
  }
  const info = realDirectory(root)
  const receiptPath = join(root, 'ownership.json')
  requireRegularFile(receiptPath)
  const bytes = readFileSync(receiptPath)
  if (digest(bytes) !== workspace.ownerDigest) throw new Error('WORKSPACE_RECEIPT_INVALID')
  const receipt = JSON.parse(bytes.toString('utf8'))
  if (
    !exactKeys(receipt, ['source', 'directories']) ||
    !sourceValid(receipt.source) ||
    Object.keys(source).some((key) => source[key] !== receipt.source[key]) ||
    !exactKeys(receipt.directories, ['root', ...CHILDREN]) ||
    !exactKeys(receipt.directories.root, ['dev', 'ino']) ||
    receipt.directories.root.dev !== info.dev ||
    receipt.directories.root.ino !== info.ino
  ) {
    throw new Error('WORKSPACE_RECEIPT_INVALID')
  }
  const paths = Object.fromEntries(CHILDREN.map((child) => [child, join(root, child)]))
  for (const [name, path] of Object.entries(paths)) {
    try {
      const child = realDirectory(path)
      const expected = receipt.directories[name]
      if (!exactKeys(expected, ['dev', 'ino']) || child.dev !== expected.dev || child.ino !== expected.ino) {
        throw new Error('WORKSPACE_RECEIPT_INVALID')
      }
    } catch (error) {
      // Verification removes inspection in finally. No other missing or replaced child is accepted.
      if (path !== paths.inspection || error?.code !== 'ENOENT') throw error
    }
  }
  return paths
}

export function cleanupWorkspace(workspace, runnerTemp, source) {
  verifyOwnedWorkspace(workspace, runnerTemp, source)
  rmSync(workspace.root, { recursive: true })
}

function requireRegularFile(path) {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size <= 0) {
    throw new Error('REGULAR_FILE_REQUIRED')
  }
  return info
}

function runTool(command, args, failure, timeout = 60_000) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 8 * 1024 * 1024
  })
  if (result.error || result.signal || result.status !== 0) throw new Error(failure)
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function walkTree(root) {
  const records = []
  function walk(path) {
    const info = lstatSync(path)
    const kind = info.isDirectory()
      ? 'directory'
      : info.isSymbolicLink()
        ? 'symlink'
        : info.isFile()
          ? 'file'
          : 'special'
    const record = { path: relative(root, path), kind, nlink: info.nlink, size: info.size }
    if (kind === 'symlink') {
      let resolved = null
      try {
        resolved = relative(root, realpathSync(path))
      } catch {
        // Missing and cyclic links remain closed invalid records, not native error text.
      }
      records.push({ ...record, target: readlinkSync(path), resolved })
    } else {
      records.push(record)
      if (kind === 'directory') {
        for (const name of readdirSync(path)) walk(join(path, name))
      }
    }
  }
  walk(root)
  return records
}

async function fileHash(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}

async function verifyPackage(workspace, runnerTemp, source, version) {
  const paths = verifyOwnedWorkspace(workspace, runnerTemp, source)
  realDirectory(paths.inspection)
  if (readdirSync(paths.inspection).length !== 0 || readdirSync(paths.report).length !== 0) {
    throw new Error('INSPECTION_NOT_EMPTY')
  }
  const failures = []
  try {
    const filename = `Metis-Native-${version}.zip`
    const outputs = readdirSync(paths.output)
    if (outputs.length !== 1 || outputs[0] !== filename) throw new Error('PACKAGE_INVENTORY_INVALID')
    const zip = join(paths.output, filename)
    const info = requireRegularFile(zip)
    const sha256 = await fileHash(zip)
    runTool('/usr/bin/unzip', ['-tqq', zip], 'ARCHIVE_INTEGRITY_FAILED')
    const listing = runTool('/usr/bin/unzip', ['-Z1', zip], 'ARCHIVE_LIST_FAILED').stdout
    const entries = listing.replace(/\n$/, '').split('\n')
    if (archiveEntryProblems(entries).length) throw new Error('ARCHIVE_ENTRIES_INVALID')
    runTool('/usr/bin/ditto', ['-x', '-k', zip, paths.inspection], 'ARCHIVE_EXTRACTION_FAILED')
    const top = readdirSync(paths.inspection)
    if (!top.includes('Metis.app') || top.some((name) => !['Metis.app', '__MACOSX'].includes(name))) {
      throw new Error('EXTRACTED_ROOT_INVALID')
    }
    const app = join(paths.inspection, 'Metis.app')
    realDirectory(app)
    if (bundleGraphProblems(walkTree(app)).length) throw new Error('BUNDLE_GRAPH_INVALID')
    if (top.includes('__MACOSX')) {
      const metadata = join(paths.inspection, '__MACOSX')
      realDirectory(metadata)
      const records = walkTree(metadata)
      if (records.some((entry) => entry.kind !== 'directory' && (entry.kind !== 'file' || entry.nlink !== 1))) {
        throw new Error('RESOURCE_GRAPH_INVALID')
      }
    }
    const plist = join(app, 'Contents', 'Info.plist')
    requireRegularFile(plist)
    const raw = runTool('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], 'BUNDLE_PLIST_INVALID').stdout
    const data = JSON.parse(raw)
    const bundle = {
      id: data.CFBundleIdentifier,
      version: data.CFBundleShortVersionString,
      build: data.CFBundleVersion,
      executable: data.CFBundleExecutable
    }
    const checkoutSha = runTool('/usr/bin/git', ['rev-parse', 'HEAD'], 'SOURCE_IDENTITY_INVALID').stdout.trim()
    if (nativeIdentityProblems({ source, checkoutSha, expectedVersion: version, bundle }).length) {
      throw new Error('BUNDLE_IDENTITY_INVALID')
    }
    const executable = join(app, 'Contents', 'MacOS', bundle.executable)
    requireRegularFile(executable)
    if (!contained(join(app, 'Contents', 'MacOS'), realpathSync(executable))) throw new Error('EXECUTABLE_OUTSIDE_APP')
    runTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], 'SIGNATURE_INTEGRITY_FAILED')
    const signing = runTool('/usr/bin/codesign', ['-dv', '--verbose=4', app], 'SIGNATURE_MODE_INVALID')
    const signature = parseAdHocSignature(`${signing.stdout}\n${signing.stderr}`)
    const slices = parseMeasuredSlices(runTool('/usr/bin/lipo', ['-archs', executable], 'SLICES_INVALID').stdout)
    // No altered archive can be reported using the pre-extraction digest.
    if (requireRegularFile(zip).size !== info.size || (await fileHash(zip)) !== sha256) {
      throw new Error('PACKAGE_CHANGED')
    }
    const report = buildNativeReport({
      source,
      checkoutSha,
      expectedVersion: version,
      asset: { filename, bytes: info.size, sha256 },
      bundle,
      slices,
      signature
    })
    writeFileSync(join(paths.report, 'native-package.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  } catch (error) {
    failures.push(new Error(closedFailure(error)))
  } finally {
    try {
      verifyOwnedWorkspace(workspace, runnerTemp, source)
      realDirectory(paths.inspection)
      rmSync(paths.inspection, { recursive: true })
    } catch {
      failures.push(new Error('NATIVE_PACKAGE_INSPECTION_CLEANUP_FAILED'))
    }
  }
  if (failures.length) throw new AggregateError(failures, 'NATIVE_PACKAGE_VERIFICATION_FAILED')
}

async function main() {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('HOSTED_MAC_REQUIRED')
  }
  const source = {
    sha: process.env.GITHUB_SHA,
    run_id: process.env.GITHUB_RUN_ID,
    run_attempt: process.env.GITHUB_RUN_ATTEMPT
  }
  if (!sourceValid(source)) throw new Error('SOURCE_IDENTITY_INVALID')
  const runnerTemp = process.env.RUNNER_TEMP
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['prepare', 'verify', 'cleanup'].includes(mode)) throw new Error('MODE_INVALID')
  if (mode === 'cleanup') {
    cleanupWorkspace(
      { root: process.env.NATIVE_PACKAGE_ROOT, ownerDigest: process.env.NATIVE_PACKAGE_OWNER },
      runnerTemp,
      source
    )
    return
  }
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  if (!validVersion(version)) throw new Error('VERSION_INVALID')
  if (mode === 'prepare') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('WORKFLOW_OUTPUT_REQUIRED')
    const workspace = allocateWorkspace(runnerTemp, source)
    try {
      const paths = verifyOwnedWorkspace(workspace, runnerTemp, source)
      const outputs = {
        root: workspace.root,
        owner_digest: workspace.ownerDigest,
        output: paths.output,
        inspection: paths.inspection,
        report: paths.report,
        zip: join(paths.output, `Metis-Native-${version}.zip`),
        metadata: join(paths.report, 'native-package.json')
      }
      if (Object.values(outputs).some((value) => /[\r\n]/.test(value))) throw new Error('WORKFLOW_OUTPUT_INVALID')
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `${Object.entries(outputs)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')}\n`
      )
    } catch (error) {
      try {
        cleanupWorkspace(workspace, runnerTemp, source)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'NATIVE_PACKAGE_VERIFICATION_FAILED')
      }
      throw error
    }
    return
  }
  await verifyPackage(
    { root: process.env.NATIVE_PACKAGE_ROOT, ownerDigest: process.env.NATIVE_PACKAGE_OWNER },
    runnerTemp,
    source,
    version
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const failures = error instanceof AggregateError ? error.errors.map(closedFailure) : [closedFailure(error)]
    console.error(`Native package baseline failed: ${failures.join(',')}. No package acceptance is claimed.`)
    process.exitCode = 1
  })
}
