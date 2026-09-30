#!/usr/bin/env node
// scripts/qa/provenance.mjs — provenance, evidence binding and release preparation for the build-once
// candidate lane (M2-0187). Node builtins only.
//
// Identified by sha256: every consumer verifies each installer's sha256 against this run's
// provenance.json before using it — evidence binds to bytes by (build_run_id, artifact_sha256).
// Published = tested: promotion uploads exactly the promotable installers, SHA256SUMS.txt and
// the unmodified provenance.json — no build, install or npm step ever runs here.
// Evidence required: promotion needs a PASS evidence record bound to this run's bytes for every
// promotable asset it stages (see evidenceProblems below for the exact rule).
//
// A function reports what it found. Functions named *Problems return string[]; empty means OK.
// stageBuild, assembleProvenance and prepareRelease throw an Error listing every problem, one per line,
// and leave the filesystem untouched when they throw.
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Every shipped target, plus the macOS QA-identity variant, which is built but never promoted. */
export const VARIANTS = Object.freeze({
  mac: {
    promotable: true,
    platform: 'mac',
    configs: ['electron-builder.yml'],
    assets: (version) => [`Metis-${version}.dmg`, `Metis-${version}.zip`]
  },
  'mac-qa-identity': {
    promotable: false,
    platform: 'mac',
    configs: ['build/qa-identity.electron-builder.yml', 'electron-builder.yml'],
    assets: (version) => [`Metis-QA-${version}.zip`]
  },
  win: {
    promotable: true,
    platform: 'win',
    configs: ['electron-builder.win.yml', 'electron-builder.yml'],
    assets: (version) => [`Metis-Setup-${version}.exe`, `Metis-Portable-${version}.exe`]
  }
})

export const PROMOTABLE_VARIANTS = Object.keys(VARIANTS).filter((variant) => VARIANTS[variant].promotable)

/** Every asset a provenance's promotable builds produced, in build order. Never includes the QA-identity
 *  build: it is built but never shipped, so evidence naming it never counts toward promotion. */
export function promotableAssets(provenance) {
  return provenance.builds.filter((build) => PROMOTABLE_VARIANTS.includes(build.variant)).flatMap((build) => build.assets)
}

/** Streaming sha256, so a multi-GB installer is never read fully into memory. */
export async function sha256File(path) {
  return await new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Strips every trailing line ending (LF or CRLF), all of it, not just the last one — the evidence
 * schema allows a CRLF file, and a lone-`\n` strip on 'x\r\n\r\n' would leave a dangling '\r\n' behind
 * and misreport it as a blank line.
 */
function stripTrailingNewlines(text) {
  return text.replace(/(\r?\n)+$/, '')
}

/** Every line of an evidence file, in order, with every trailing line ending removed first. An empty
 *  file (or one holding only line endings) has zero lines, not one empty line. */
function evidenceLines(text) {
  const stripped = stripTrailingNewlines(text)
  return stripped === '' ? [] : stripped.split(/\r?\n/)
}

/**
 * win is always unsigned, whatever the environment holds. mac is signed with the lane's stable QA
 * identity when the owner has stored one, and ad-hoc otherwise — never a Developer ID.
 */
function resolveSigning(platform, env) {
  if (platform === 'win') return { mode: 'unsigned' }
  const identity = env.ASKTOTO_MAC_SIGN_IDENTITY
  if (!identity) return { mode: 'ad-hoc' }
  if (!/^[0-9A-Fa-f]{40}$/.test(identity)) {
    throw new Error(`ASKTOTO_MAC_SIGN_IDENTITY is not a 40-character certificate fingerprint: ${JSON.stringify(identity)}`)
  }
  return { mode: 'qa-identity', certificate_sha1: identity.toLowerCase() }
}

const RUNNER_FIELDS = { os: 'RUNNER_OS', arch: 'RUNNER_ARCH', image: 'ImageOS', image_version: 'ImageVersion' }

/** Reads and hashes one file, folding any error (missing, unreadable) into `problems` by its path. */
function readAndHash(repoRoot, path, problems) {
  try {
    return sha256Bytes(readFileSync(join(repoRoot, path)))
  } catch (error) {
    problems.push(`cannot read ${path}: ${error.message}`)
    return undefined
  }
}

/** Reads one `node_modules/<name>/package.json`'s version, folding any error into `problems`. */
function readDependencyVersion(repoRoot, name, problems) {
  const path = join('node_modules', name, 'package.json')
  try {
    return JSON.parse(readFileSync(join(repoRoot, path), 'utf8')).version
  } catch (error) {
    problems.push(`cannot read ${path}: ${error.message}`)
    return undefined
  }
}

/**
 * Stages one variant's installers out of `releaseDir` into `<outDir>/assets/`, hashes them, and writes
 * `<outDir>/build-<variant>.json`. Validates everything first, including every file this function reads
 * besides the installers themselves: a failure moves nothing.
 */
export async function stageBuild({ variant, repoRoot, releaseDir, outDir, env, nodeVersion }) {
  const config = VARIANTS[variant]
  if (!config) throw new Error(`unknown variant: ${variant}`)

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const version = pkg.version
  const expectedAssets = config.assets(version)

  const problems = []

  const sha = env.GITHUB_SHA ?? ''
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    problems.push(`GITHUB_SHA is not a 40-character lowercase commit hash: ${JSON.stringify(sha)}`)
  }

  const runner = Object.fromEntries(Object.entries(RUNNER_FIELDS).map(([field, envVar]) => [field, env[envVar] ?? '']))
  for (const [field, value] of Object.entries(runner)) {
    if (!value) problems.push(`${RUNNER_FIELDS[field]} is empty: the runner image cannot be recorded`)
  }

  let signing
  try {
    signing = resolveSigning(config.platform, env)
  } catch (error) {
    problems.push(error.message)
  }

  const releaseFiles = existsSync(releaseDir) ? readdirSync(releaseDir) : []
  for (const name of expectedAssets) {
    if (!releaseFiles.includes(name)) {
      problems.push(`${variant}: the build produced no ${name} in ${basename(releaseDir)}/`)
    }
  }

  const builderConfig = config.configs.map((path) => ({ path, sha256: readAndHash(repoRoot, path, problems) }))
  const electron = readDependencyVersion(repoRoot, 'electron', problems)
  const electronBuilder = readDependencyVersion(repoRoot, 'electron-builder', problems)

  if (problems.length) throw new Error(problems.join('\n'))

  const assetsDir = join(outDir, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  const assets = []
  for (const name of expectedAssets) {
    const from = join(releaseDir, name)
    const to = join(assetsDir, name)
    const { size } = statSync(from)
    renameSync(from, to)
    assets.push({ name, size, sha256: await sha256File(to) })
  }

  const record = {
    variant,
    artifact: `candidate-${variant}`,
    commit: sha,
    version,
    runner,
    node: nodeVersion,
    electron,
    electron_builder: electronBuilder,
    builder_config: builderConfig,
    signing,
    assets
  }

  writeFileSync(join(outDir, `build-${variant}.json`), `${JSON.stringify(record, null, 2)}\n`)
  return record
}

/** Binds every per-variant build record to one commit and run, and returns the object written to provenance.json. */
export function assembleProvenance(records, env) {
  const problems = []

  const sha = env.GITHUB_SHA ?? ''
  if (!/^[0-9a-f]{40}$/.test(sha)) problems.push(`GITHUB_SHA is not a 40-character lowercase commit hash: ${JSON.stringify(sha)}`)
  const runId = Number(env.GITHUB_RUN_ID)
  if (!Number.isInteger(runId) || runId <= 0) {
    problems.push(`GITHUB_RUN_ID is not a positive integer: ${JSON.stringify(env.GITHUB_RUN_ID)}`)
  }
  if (!env.GITHUB_REPOSITORY) problems.push('GITHUB_REPOSITORY is empty')
  if (!env.GITHUB_SERVER_URL) problems.push('GITHUB_SERVER_URL is empty')

  const byVariant = new Map()
  for (const record of records) {
    if (!VARIANTS[record.variant]) {
      problems.push(`unknown variant: ${record.variant}`)
      continue
    }
    if (byVariant.has(record.variant)) {
      problems.push(`duplicate variant: ${record.variant}`)
      continue
    }
    byVariant.set(record.variant, record)
  }
  for (const variant of Object.keys(VARIANTS)) {
    if (!byVariant.has(variant)) problems.push(`missing variant: ${variant}`)
  }

  for (const record of byVariant.values()) {
    if (record.commit !== sha) {
      problems.push(`${record.variant}: commit ${record.commit} does not match this run's commit ${sha}`)
    }
  }
  const versions = new Set([...byVariant.values()].map((record) => record.version))
  if (versions.size > 1) {
    problems.push(`builds disagree on version: ${[...versions].join(', ')}`)
  }
  const ownerOfAsset = new Map()
  for (const record of byVariant.values()) {
    for (const asset of record.assets) {
      if (ownerOfAsset.has(asset.name)) {
        problems.push(`asset name ${asset.name} appears in both ${ownerOfAsset.get(asset.name)} and ${record.variant}`)
      } else {
        ownerOfAsset.set(asset.name, record.variant)
      }
    }
  }

  // One commit means one config: two variants that both list the same builder_config path must have
  // hashed the same bytes. A disagreement means at least one runner's checkout rewrote the file (for
  // example CRLF line endings on Windows), and the resulting provenance would misreport what config
  // built which asset.
  const configHashesByPath = new Map()
  for (const record of byVariant.values()) {
    for (const config of record.builder_config) {
      const seen = configHashesByPath.get(config.path)
      if (!seen) {
        configHashesByPath.set(config.path, { sha256: config.sha256, variant: record.variant })
      } else if (seen.sha256 !== config.sha256) {
        problems.push(
          `${config.path}: ${seen.variant} recorded sha256 ${seen.sha256} but ${record.variant} recorded ${config.sha256} — one commit means one config`
        )
      }
    }
  }

  if (problems.length) throw new Error(problems.join('\n'))

  const version = [...byVariant.values()][0].version
  const builds = [...byVariant.values()]
    .sort((a, b) => a.variant.localeCompare(b.variant))
    // commit and version are hoisted to the top and dropped from every build.
    .map(({ commit, version: _version, ...rest }) => rest)

  return {
    schema: 1,
    repository: env.GITHUB_REPOSITORY,
    commit: sha,
    version,
    run: { id: runId, url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}` },
    builds
  }
}

/** `shasum -a 256 -c`'s format: one `<sha256>  <name>` line per asset, sorted by name. */
export function sha256Sums(assets) {
  return [...assets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((asset) => `${asset.sha256}  ${asset.name}\n`)
    .join('')
}

/** Reports every way `dir` fails to hold exactly the named variants' assets. */
export async function directoryProblems(provenance, dir, variants) {
  const problems = []
  const expected = []
  for (const variant of variants) {
    const build = provenance.builds.find((b) => b.variant === variant)
    if (!build) {
      problems.push(`provenance has no build for variant ${variant}`)
      continue
    }
    expected.push(...build.assets)
  }
  if (problems.length) return problems

  const expectedByName = new Map(expected.map((asset) => [asset.name, asset]))
  const actualNames = existsSync(dir) ? readdirSync(dir) : []
  for (const name of actualNames) {
    if (!expectedByName.has(name)) problems.push(`unexpected file in ${dir}: ${name}`)
  }
  for (const asset of expected) {
    const path = join(dir, asset.name)
    if (!existsSync(path)) {
      problems.push(`missing file: ${asset.name}`)
      continue
    }
    const { size } = statSync(path)
    if (size !== asset.size) {
      problems.push(`${asset.name} is ${size} bytes; provenance records ${asset.size}`)
      continue
    }
    const sha256 = await sha256File(path)
    if (sha256 !== asset.sha256) {
      problems.push(`${asset.name} sha256 ${sha256} does not match provenance ${asset.sha256}`)
    }
  }
  return problems
}

/**
 * Checks that evidence text binds a PASS record to this candidate's run and to every promotable
 * asset's bytes — one record naming one asset never covers a different asset or platform. Trailing
 * newlines are ignored; an interior blank line is a problem. Only ticket, result, build_run_id and
 * artifact_sha256 are read — full record validation belongs to M2-0002's checker.
 */
export function evidenceProblems(evidenceText, provenance) {
  const assets = promotableAssets(provenance)
  const promotableHashes = new Set(assets.map((asset) => asset.sha256))
  const problems = []
  const coveredHashes = new Set()

  const lines = evidenceLines(evidenceText)
  lines.forEach((line, index) => {
    const n = index + 1
    if (line.trim() === '') {
      problems.push(`line ${n} is blank`)
      return
    }
    let record
    try {
      record = JSON.parse(line)
    } catch {
      problems.push(`line ${n} is not valid JSON`)
      return
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      problems.push(`line ${n} is not a JSON object`)
      return
    }
    if (!/^M2-\d{4}$/.test(record.ticket ?? '')) {
      problems.push(`line ${n} has no valid ticket id: ${JSON.stringify(record.ticket)}`)
      return
    }
    if (record.result !== 'PASS') {
      problems.push(`line ${n} (${record.ticket}) is ${record.result ?? 'not PASS'}, not PASS`)
      return
    }
    if (record.build_run_id !== provenance.run.id) {
      problems.push(
        `line ${n} (${record.ticket}) is bound to run ${record.build_run_id}, not this candidate's run ${provenance.run.id}`
      )
      return
    }
    if (!promotableHashes.has(record.artifact_sha256)) {
      problems.push(`line ${n} (${record.ticket}) names a sha256 that is not one of this candidate's promotable assets`)
      return
    }
    coveredHashes.add(record.artifact_sha256)
  })

  for (const asset of assets) {
    if (!coveredHashes.has(asset.sha256)) {
      problems.push(`no PASS record bound to run ${provenance.run.id} covers ${asset.name} (sha256 ${asset.sha256})`)
    }
  }

  return problems
}

/**
 * releaseNotes' shape is normative: version, commit, candidate run, promotion run, owner-channel/
 * hand-install framing (never Latest), signing mode and the evidence summary. A release/1.9.x candidate adds
 * one line naming it a hotfix of 1.9.7.
 */
export function releaseNotes({ provenance, evidence, promotionRunUrl, candidateBranch = 'main' }) {
  const macBuild = provenance.builds.find((build) => build.variant === 'mac')
  const macSigning =
    macBuild.signing.mode === 'qa-identity'
      ? `The macOS app is signed with the program's self-signed QA certificate (SHA-1 \`${macBuild.signing.certificate_sha1}\`), not a Developer ID, and it is not notarized.`
      : 'The macOS app is ad-hoc signed and not notarized.'

  const assets = promotableAssets(provenance).sort((a, b) => a.name.localeCompare(b.name))
  const rows = assets.map((asset) => `| \`${asset.name}\` | \`${asset.sha256}\` |`).join('\n')

  const hotfix =
    candidateBranch === 'release/1.9.x'
      ? `**Hotfix:** a hotfix of 1.9.7 built from release/1.9.x at commit \`${provenance.commit}\`.\n\n`
      : ''

  return `Owner-channel prerelease of Métis ${provenance.version}. These files are the exact bytes of QA candidate run [${provenance.run.id}](${provenance.run.url}), built once from commit \`${provenance.commit}\` and promoted by [this run](${promotionRunUrl}) without rebuilding.

**This is not a signed customer release.** ${macSigning} The Windows installers carry no Authenticode signature. On macOS, allow the first launch in System Settings → Privacy & Security → Open Anyway; on Windows, choose More info → Run anyway. In-app update does not offer this build, so install it by hand.

${hotfix}**Evidence:** ${evidence.count} passing record(s) (${evidence.tickets.join(', ')}) bound to these bytes. Evidence file SHA-256: \`${evidence.sha256}\`.

| File | SHA-256 |
|---|---|
${rows}

\`provenance.json\` records the commit, the candidate run, the runner images and the Node, Electron and electron-builder versions and builder configuration hashes of every build. Check a download with \`shasum -a 256 -c SHA256SUMS.txt\` on macOS or \`Get-FileHash\` on Windows.
`
}

/**
 * Never builds. Proves the candidate's provenance and the promotion evidence, then stages exactly the
 * promotable bytes plus SHA256SUMS.txt and the original provenance.json bytes for upload.
 */
export async function prepareRelease({ provenancePath, evidencePath, downloadsDir, outDir, candidateRun, candidateCommit, candidateBranch, env }) {
  const provenanceBytes = readFileSync(provenancePath)
  const provenance = JSON.parse(provenanceBytes.toString('utf8'))
  const evidenceBytes = readFileSync(evidencePath)
  const evidenceText = evidenceBytes.toString('utf8')

  const problems = []
  if (String(provenance.run.id) !== String(candidateRun)) {
    problems.push(`provenance run ${provenance.run.id} does not match the candidate run ${candidateRun}`)
  }
  if (provenance.commit !== candidateCommit) {
    problems.push(`provenance commit ${provenance.commit} does not match the candidate commit ${candidateCommit}`)
  }
  problems.push(...evidenceProblems(evidenceText, provenance))
  problems.push(...(await directoryProblems(provenance, downloadsDir, PROMOTABLE_VARIANTS)))

  if (problems.length) throw new Error(problems.join('\n'))

  const uploadDir = join(outDir, 'upload')
  mkdirSync(uploadDir, { recursive: true })

  const assets = promotableAssets(provenance)
  for (const asset of assets) {
    renameSync(join(downloadsDir, asset.name), join(uploadDir, asset.name))
  }
  writeFileSync(join(uploadDir, 'SHA256SUMS.txt'), sha256Sums(assets))
  writeFileSync(join(uploadDir, 'provenance.json'), provenanceBytes)

  const manifest = []
  for (const name of readdirSync(uploadDir)) {
    const path = join(uploadDir, name)
    const { size } = statSync(path)
    manifest.push({ name, size, sha256: await sha256File(path) })
  }
  manifest.sort((a, b) => a.name.localeCompare(b.name))
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const evidenceRecords = evidenceLines(evidenceText).map((line) => JSON.parse(line))
  const tickets = [...new Set(evidenceRecords.map((record) => record.ticket))].sort()
  const evidence = { count: evidenceRecords.length, tickets, sha256: sha256Bytes(evidenceBytes) }
  const promotionRunUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`

  const notes = releaseNotes({ provenance, evidence, promotionRunUrl, candidateBranch })
  writeFileSync(join(outDir, 'notes.md'), notes)

  return { manifest, notes }
}

/** Checks GitHub's reported asset list against the local upload manifest before a draft is published. */
export function uploadProblems(manifest, uploaded) {
  const problems = []
  const manifestByName = new Map(manifest.map((asset) => [asset.name, asset]))
  const uploadedByName = new Map(uploaded.map((asset) => [asset.name, asset]))

  for (const name of manifestByName.keys()) {
    if (!uploadedByName.has(name)) problems.push(`${name} was not uploaded`)
  }
  for (const name of uploadedByName.keys()) {
    if (!manifestByName.has(name)) problems.push(`${name} was uploaded but is not in the manifest`)
  }
  for (const [name, expected] of manifestByName) {
    const actual = uploadedByName.get(name)
    if (!actual) continue
    if (actual.state !== 'uploaded') problems.push(`${name} is ${actual.state}, not uploaded`)
    if (actual.size !== expected.size) {
      problems.push(`${name} is ${actual.size} bytes on GitHub; the manifest expects ${expected.size}`)
    }
    if (!actual.digest) {
      problems.push(`GitHub reported no digest for ${name}; the uploaded bytes cannot be proven`)
    } else if (actual.digest !== `sha256:${expected.sha256}`) {
      problems.push(`${name} digest ${actual.digest} does not match the manifest's sha256:${expected.sha256}`)
    }
  }
  return problems
}

function flagValue(flags, name) {
  const index = flags.indexOf(name)
  return index === -1 ? undefined : flags[index + 1]
}

function usage() {
  console.error(
    'usage: provenance.mjs <stage|assemble|verify|prepare-release|check-release> ...\n' +
      '  stage <variant> <release-dir> <out-dir>\n' +
      '  assemble <records-dir> <out-dir>\n' +
      '  verify <provenance.json> <dir> <variant>...\n' +
      '  prepare-release <provenance.json> <evidence.jsonl> <downloads-dir> <out-dir> --candidate-run <id> --candidate-commit <sha> [--candidate-branch <head_branch>]\n' +
      '  check-release <manifest.json> <uploaded.json>'
  )
  process.exitCode = 2
}

async function main(argv) {
  const [command, ...rest] = argv
  try {
    switch (command) {
      case 'stage': {
        const [variant, releaseDir, outDir] = rest
        if (!variant || !releaseDir || !outDir) return usage()
        await stageBuild({ variant, repoRoot: process.cwd(), releaseDir, outDir, env: process.env, nodeVersion: process.version })
        break
      }
      case 'assemble': {
        const [recordsDir, outDir] = rest
        if (!recordsDir || !outDir) return usage()
        const files = readdirSync(recordsDir).filter((name) => name.startsWith('build-') && name.endsWith('.json'))
        const records = files.map((name) => JSON.parse(readFileSync(join(recordsDir, name), 'utf8')))
        const provenance = assembleProvenance(records, process.env)
        mkdirSync(outDir, { recursive: true })
        writeFileSync(join(outDir, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`)
        writeFileSync(join(outDir, 'SHA256SUMS.txt'), sha256Sums(provenance.builds.flatMap((build) => build.assets)))
        break
      }
      case 'verify': {
        const [provenancePath, dir, ...variants] = rest
        if (!provenancePath || !dir || variants.length === 0) return usage()
        const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'))
        const problems = await directoryProblems(provenance, dir, variants)
        if (problems.length) throw new Error(problems.join('\n'))
        break
      }
      case 'prepare-release': {
        const [provenancePath, evidencePath, downloadsDir, outDir, ...flags] = rest
        if (!provenancePath || !evidencePath || !downloadsDir || !outDir) return usage()
        const candidateRun = flagValue(flags, '--candidate-run')
        const candidateCommit = flagValue(flags, '--candidate-commit')
        const candidateBranch = flagValue(flags, '--candidate-branch')
        if (!candidateRun || !candidateCommit) return usage()
        await prepareRelease({ provenancePath, evidencePath, downloadsDir, outDir, candidateRun, candidateCommit, candidateBranch, env: process.env })
        break
      }
      case 'check-release': {
        const [manifestPath, uploadedPath] = rest
        if (!manifestPath || !uploadedPath) return usage()
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const uploaded = JSON.parse(readFileSync(uploadedPath, 'utf8'))
        const problems = uploadProblems(manifest, uploaded)
        if (problems.length) throw new Error(problems.join('\n'))
        break
      }
      default:
        return usage()
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}
