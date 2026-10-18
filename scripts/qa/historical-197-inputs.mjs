#!/usr/bin/env node
// Historical identity only. This module never downloads, installs, rebuilds, signs or publishes.
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ASSETS = Object.freeze([
  { id: 645178383, name: 'Metis-1.9.7.dmg', size: 1827516056, sha256: '3ff51e9d50eb1413361c7be68ab542361bae5dad63fa22031e08b5be7bc5a304' },
  { id: 645180903, name: 'Metis-1.9.7.zip', size: 1826734829, sha256: '6fbf0b72fba0e2f70ee53adf2f7e73224d2deab432a79afc2ed1874396cb8edc' },
  { id: 645183715, name: 'Metis-Setup-1.9.7.exe', size: 1533431944, sha256: '40a791388df139e0cd1c01cdf33ccf1f0a530192820434a967802371de0f3416' },
  { id: 645185922, name: 'provenance.json', size: 4106, sha256: 'd3a6872da5e1b3fb3aed651d860c399265d20edaa88fb27cc4d3ffd18a092104' },
  { id: 645185936, name: 'SHA256SUMS.txt', size: 252, sha256: '39aec8ab23e19d6f0e5d240a86072c2b904caed651296d6e8d2a4d863802ddc3' }
].map((asset) => Object.freeze(asset)))

export const HISTORICAL_197 = Object.freeze({
  repository: 'mysticalsin/AskToto-Mantu', repositoryId: 1282463398,
  artifactSource: '98461f85dcca49a2ded3f1489daed10d194f5229',
  candidateRun: 38795048288, candidateAttempt: 1,
  releaseId: 414278048, tag: 'metis-unsigned-v1.9.7', assets: ASSETS
})
const CONFIGS = Object.freeze({
  'electron-builder.yml': 'ec8afce51d3971f7138f24a8c27775b1a799a77b73a9bfdb6c91bb30d71f577a',
  'electron-builder.win.yml': '89fab48e8807686c29bc625ddce12c8dbc0ea1e33478b7454928e24b7f6c1497',
  'build/qa-identity.electron-builder.yml': '1021777aafe8093552cafd9adc54c2c26907987a6a0414ce62808888c6c17a68'
})
const BUILD_VARIANTS = ['mac', 'mac-qa-identity', 'win', 'win-portable']
const FAILURE_CODES = new Set([
  'invalid-input', 'context-mismatch', 'provenance-mismatch', 'checksums-mismatch',
  'asset-set-mismatch', 'asset-bytes-mismatch', 'unsafe-file', 'file-changed', 'input-unreadable'
])
const MAX_CONTEXT_BYTES = 16_384

class VerificationFailure extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}
const requireValue = (condition, code) => {
  if (!condition) throw new VerificationFailure(code)
}
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const sameRepository = (value) => exact(value, ['id', 'full_name']) &&
  value.id === HISTORICAL_197.repositoryId && value.full_name === HISTORICAL_197.repository
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bytesMatch = (bytes, asset) => bytes instanceof Uint8Array &&
  bytes.byteLength === asset.size && digest(bytes) === asset.sha256
const refusal = (error) => ({
  scope: 'IDENTITY_ONLY', outcome: 'REFUSED',
  code: error instanceof VerificationFailure && FAILURE_CODES.has(error.code) ? error.code : 'input-unreadable'
})

function checkContext(metadata) {
  const fail = 'context-mismatch'
  requireValue(exact(metadata, ['repository', 'candidateRun', 'release', 'harnessCommit']), fail)
  requireValue(sameRepository(metadata.repository) && typeof metadata.harnessCommit === 'string' &&
    /^[0-9a-f]{40}$/.test(metadata.harnessCommit), fail)
  const run = metadata.candidateRun
  requireValue(exact(run, ['id', 'run_attempt', 'path', 'event', 'head_branch', 'head_sha', 'status', 'conclusion', 'repository', 'head_repository']), fail)
  requireValue(run.id === HISTORICAL_197.candidateRun && run.run_attempt === 1 &&
    run.path === '.github/workflows/qa-candidate.yml' && run.event === 'workflow_dispatch' &&
    run.head_branch === 'main' && run.head_sha === HISTORICAL_197.artifactSource &&
    run.status === 'completed' && run.conclusion === 'success' &&
    sameRepository(run.repository) && sameRepository(run.head_repository), fail)
  const release = metadata.release
  requireValue(exact(release, ['id', 'tag_name', 'name', 'target_commitish', 'draft', 'prerelease', 'assets']), fail)
  requireValue(release.id === HISTORICAL_197.releaseId && release.tag_name === HISTORICAL_197.tag &&
    release.name === 'Métis 1.9.7 (unsigned, manual install)' &&
    release.target_commitish === HISTORICAL_197.artifactSource && release.draft === false &&
    typeof release.prerelease === 'boolean', fail)
  requireValue(Array.isArray(release.assets) && release.assets.length === ASSETS.length, fail)
  for (const asset of ASSETS) {
    const matches = release.assets.filter((candidate) => candidate?.name === asset.name)
    requireValue(matches.length === 1, fail)
    const actual = matches[0]
    requireValue(exact(actual, ['id', 'name', 'size', 'digest']) && actual.id === asset.id &&
      actual.size === asset.size && actual.digest === `sha256:${asset.sha256}`, fail)
  }
}

function checkProvenance(bytes) {
  const fail = 'provenance-mismatch'
  // The original whole-byte digest preserves every original build/runner/tool/signing/config fact.
  requireValue(bytesMatch(bytes, ASSETS[3]), fail)
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  requireValue(exact(value, ['schema', 'repository', 'commit', 'version', 'run', 'builds']) &&
    value.schema === 2 && value.repository === HISTORICAL_197.repository &&
    value.commit === HISTORICAL_197.artifactSource && value.version === '1.9.7', fail)
  requireValue(exact(value.run, ['id', 'attempt', 'url']) && value.run.id === HISTORICAL_197.candidateRun &&
    value.run.attempt === 1 && value.run.url === `https://github.com/${HISTORICAL_197.repository}/actions/runs/${HISTORICAL_197.candidateRun}`, fail)
  requireValue(Array.isArray(value.builds) && value.builds.length === BUILD_VARIANTS.length, fail)
  for (const [index, build] of value.builds.entries()) {
    // Actual schema 2 has top-level version and deliberately no build.version field.
    requireValue(exact(build, ['variant', 'artifact', 'platform', 'runner', 'node', 'electron', 'electron_builder', 'builder_config', 'signing', 'assets']) &&
      build.variant === BUILD_VARIANTS[index] && build.artifact === `candidate-${build.variant}`, fail)
    const configPaths = build.variant === 'mac' ? ['electron-builder.yml']
      : build.variant === 'mac-qa-identity' ? ['build/qa-identity.electron-builder.yml', 'electron-builder.yml']
        : ['electron-builder.win.yml', 'electron-builder.yml']
    requireValue(Array.isArray(build.builder_config) && build.builder_config.length === configPaths.length &&
      build.builder_config.every((config, position) => exact(config, ['path', 'sha256']) &&
        config.path === configPaths[position] && config.sha256 === CONFIGS[config.path]), fail)
  }
  for (const asset of ASSETS.slice(0, 3)) {
    const matches = value.builds.filter((build) => build.variant === 'mac' || build.variant === 'win')
      .flatMap((build) => build.assets).filter((candidate) => candidate.name === asset.name)
    requireValue(matches.length === 1 && exact(matches[0], ['name', 'size', 'sha256']) &&
      matches[0].size === asset.size && matches[0].sha256 === asset.sha256, fail)
  }
}

function checkSums(bytes) {
  requireValue(bytesMatch(bytes, ASSETS[4]), 'checksums-mismatch')
  const expected = ASSETS.slice(0, 3).map((asset) => `${asset.sha256}  ${asset.name}\n`).join('')
  requireValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes) === expected, 'checksums-mismatch')
}

function identityReceipt(metadata, verification) {
  return {
    scope: 'IDENTITY_ONLY', outcome: 'VERIFIED', verification,
    repository: HISTORICAL_197.repository,
    artifact_source: HISTORICAL_197.artifactSource, harness_commit: metadata.harnessCommit,
    candidate_run: HISTORICAL_197.candidateRun, candidate_attempt: HISTORICAL_197.candidateAttempt,
    release_id: HISTORICAL_197.releaseId, tag: HISTORICAL_197.tag,
    assets: ASSETS.map((asset) => ({ ...asset }))
  }
}

/** Metadata-only is not a receipt that the installer files have been read or tested. */
export function validateHistorical197Metadata(metadata, provenanceBytes, sumsBytes) {
  try {
    checkContext(metadata)
    checkProvenance(provenanceBytes)
    checkSums(sumsBytes)
    return identityReceipt(metadata, 'metadata-only')
  } catch (error) {
    return refusal(error)
  }
}

function unchanged(before, after) {
  return after.isFile() && before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
}

async function readOwnedFile(path, maximum, exactSize, consume) {
  let handle
  let failure
  let count = 0
  try {
    const initial = await lstat(path)
    requireValue(initial.isFile() && !initial.isSymbolicLink(), 'unsafe-file')
    requireValue(initial.size <= maximum && (exactSize === undefined || initial.size === exactSize), 'asset-bytes-mismatch')
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const opened = await handle.stat()
    requireValue(unchanged(initial, opened), 'file-changed')
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      count += chunk.length
      requireValue(count <= maximum, 'asset-bytes-mismatch')
      consume(chunk)
    }
    requireValue(count === initial.size && unchanged(opened, await handle.stat()), 'file-changed')
  } catch (error) {
    failure = error instanceof VerificationFailure ? error : new VerificationFailure('input-unreadable')
  }
  try {
    await handle?.close()
  } catch {
    failure ??= new VerificationFailure('input-unreadable')
  }
  if (failure) throw failure
  return count
}

/** Real bounded streaming bytes, independently testable without pretending tiny files are installers. */
export async function hashHistorical197File(path, expected) {
  requireValue(typeof path === 'string' && path.length > 0 && Number.isSafeInteger(expected?.size) &&
    expected.size >= 0 && /^[0-9a-f]{64}$/.test(expected.sha256), 'invalid-input')
  const hash = createHash('sha256')
  const size = await readOwnedFile(path, expected.size, expected.size, (chunk) => hash.update(chunk))
  const sha256 = hash.digest('hex')
  requireValue(sha256 === expected.sha256, 'asset-bytes-mismatch')
  return { size, sha256 }
}

async function readBounded(path, maximum, exactSize = undefined) {
  const chunks = []
  await readOwnedFile(path, maximum, exactSize, (chunk) => chunks.push(chunk))
  return Buffer.concat(chunks)
}

/** Verify only explicit already-downloaded local assets. No network, installer or release operation. */
export async function verifyHistorical197Inputs(input) {
  try {
    requireValue(exact(input, ['metadata', 'assetDirectory']), 'invalid-input')
    const { metadata, assetDirectory } = input
    requireValue(typeof assetDirectory === 'string' && assetDirectory.length > 0, 'invalid-input')
    checkContext(metadata)
    const directory = await lstat(assetDirectory)
    requireValue(directory.isDirectory() && !directory.isSymbolicLink(), 'unsafe-file')
    const entries = await readdir(assetDirectory, { withFileTypes: true })
    requireValue(entries.length === ASSETS.length && entries.every((entry) => ASSETS.some((asset) => asset.name === entry.name)), 'asset-set-mismatch')
    requireValue(entries.every((entry) => entry.isFile() && !entry.isSymbolicLink()), 'unsafe-file')
    checkProvenance(await readBounded(join(assetDirectory, 'provenance.json'), ASSETS[3].size, ASSETS[3].size))
    checkSums(await readBounded(join(assetDirectory, 'SHA256SUMS.txt'), ASSETS[4].size, ASSETS[4].size))
    for (const asset of ASSETS) await hashHistorical197File(join(assetDirectory, asset.name), asset)
    return identityReceipt(metadata, 'local-bytes')
  } catch (error) {
    return refusal(error)
  }
}

async function cli(argv) {
  try {
    const allowed = ['--metadata', '--assets', '--harness-commit']
    const args = new Map()
    requireValue(argv.length === 6, 'invalid-input')
    for (let index = 0; index < argv.length; index += 2) {
      const key = argv[index]
      const value = argv[index + 1]
      requireValue(allowed.includes(key) && !args.has(key) && typeof value === 'string' && value.length > 0, 'invalid-input')
      args.set(key, value)
    }
    requireValue(/^[0-9a-f]{40}$/.test(args.get('--harness-commit')), 'invalid-input')
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(args.get('--metadata'), MAX_CONTEXT_BYTES)))
    requireValue(metadata.harnessCommit === args.get('--harness-commit'), 'context-mismatch')
    return await verifyHistorical197Inputs({ metadata, assetDirectory: args.get('--assets') })
  } catch (error) {
    return refusal(error)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = await cli(process.argv.slice(2))
  process.exitCode = receipt.outcome === 'VERIFIED' ? 0 : 1
  process.stdout.on('error', () => { process.exitCode = 1 })
  process.stdout.write(`${JSON.stringify(receipt)}\n`)
}
