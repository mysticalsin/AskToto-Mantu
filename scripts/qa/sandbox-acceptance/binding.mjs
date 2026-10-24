// G88 (CAP-40): every acceptance report binds the exact artifact it judged: commit, run, installer sha256, app hash.
//   hosted  : --provenance names a schema-2 provenance.json from a qa-candidate run; the installer sha256 must be one of its
//             builds[].assets[].sha256, and the provenance must pass provenanceProblems (not re-implemented here).
//   local   : no provenance. The commit is the harness checkout's HEAD and the tree must be clean. The label says honestly that the
//             zip -> commit link is asserted by the person running it, not proven.
// The installer hash comes from the install receipt install.mjs wrote (the zip's sha256), never from a guessed path. The app hash is
// the sha256 of Contents/Resources/app.asar of the installed bundle. Hashes, ids and urls only; the provenance file is not echoed.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTool } from './exec.mjs'
import { sha256File } from './lib.mjs'
import { provenanceProblems } from '../provenance.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/

/** sha256 of the installed bundle's app.asar, or null when it cannot be read. */
export function appAsarSha256(appPath, hash = sha256File) {
  try {
    return hash(join(appPath, 'Contents', 'Resources', 'app.asar'))
  } catch {
    return null
  }
}

/**
 * HEAD and cleanliness of the harness checkout. `run` is the runTool seam.
 * @returns {{ commit: string | null, clean: boolean, problem?: string }}
 */
export function readLocalSource(cwd, run = runTool, git = '/usr/bin/git') {
  const head = run(git, ['-C', cwd, 'rev-parse', 'HEAD'], { timeoutMs: 15_000 })
  const commit = head.stdout.trim()
  if (head.status !== 0 || !HEX40.test(commit))
    return { commit: null, clean: false, problem: 'git rev-parse HEAD failed in the harness checkout' }
  const status = run(git, ['-C', cwd, 'status', '--porcelain'], { timeoutMs: 30_000 })
  if (status.status !== 0) return { commit, clean: false, problem: 'git status failed in the harness checkout' }
  return { commit, clean: status.stdout.trim().length === 0 }
}

/**
 * Where the artifact came from: the validated provenance (hosted) or the clean harness checkout (local-asserted).
 * `installerSha256` null skips the asset check (used before launch when the installer is not known yet).
 * @param {{ provenance?: any, local?: { commit: string | null, clean: boolean, problem?: string } | null, installerSha256?: string | null, runId: string }} args
 * @returns {{ source: { commit: string, run: Record<string, unknown>, bindingSource: string } | null, problems: string[] }}
 */
export function resolveSource({ provenance = null, local = null, installerSha256 = null, runId }) {
  const problems = []
  if (provenance) {
    const bad = provenanceProblems(provenance)
    if (bad.length) problems.push(`provenance refused: ${bad[0]}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}`)
    const assetHashes = (provenance.builds ?? []).flatMap((build) => (build.assets ?? []).map((asset) => asset.sha256))
    if (installerSha256 && !assetHashes.includes(installerSha256))
      problems.push('the installer sha256 is not a builds[].assets[].sha256 of the provenance')
    if (problems.length) return { source: null, problems }
    return {
      source: {
        commit: provenance.commit,
        run: { kind: 'hosted', id: provenance.run.id, attempt: provenance.run.attempt, url: provenance.run.url },
        bindingSource: 'provenance'
      },
      problems
    }
  }
  if (!local?.commit) problems.push(local?.problem ?? 'no source commit: pass --provenance or run from a git checkout')
  else if (!local.clean)
    problems.push(local.problem ?? 'the harness checkout has uncommitted changes: commit them or pass --provenance')
  if (problems.length) return { source: null, problems }
  return { source: { commit: local.commit, run: { kind: 'local', runId }, bindingSource: 'local-asserted' }, problems }
}

/**
 * Build the binding block. Pure: every input is passed in.
 * @param {{ installReceipt: any, appHash: string | null, provenance?: any, local?: { commit: string | null, clean: boolean, problem?: string } | null, runId: string }} args
 * @returns {{ binding: Record<string, unknown> | null, problems: string[] }}
 */
export function bindArtifact({ installReceipt, appHash, provenance = null, local = null, runId }) {
  const problems = []
  const installerSha256 = installReceipt?.zip?.sha256
  const mainExecutableSha256 = installReceipt?.app?.mainExecutableSha256
  if (installReceipt?.schema !== 'sandbox-install/1')
    problems.push('no readable install receipt: run install.mjs first')
  if (!HEX64.test(installerSha256 ?? '')) problems.push('the install receipt carries no installer sha256')
  if (!HEX64.test(mainExecutableSha256 ?? '')) problems.push('the install receipt carries no main executable sha256')
  if (!HEX64.test(appHash ?? '')) problems.push('the installed bundle has no readable app.asar to hash')
  const resolved = resolveSource({
    provenance,
    local,
    installerSha256: HEX64.test(installerSha256 ?? '') ? installerSha256 : null,
    runId
  })
  problems.push(...resolved.problems)
  if (problems.length || !resolved.source) return { binding: null, problems }
  return {
    binding: {
      commit: resolved.source.commit,
      run: resolved.source.run,
      installerSha256,
      appHash,
      mainExecutableSha256,
      bundleVersion: installReceipt?.app?.version ?? null,
      bindingSource: resolved.source.bindingSource
    },
    problems
  }
}

/** The harness checkout (three levels above scripts/qa/sandbox-acceptance). */
export const HARNESS_CHECKOUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const readJsonOrNull = (path, read) => {
  try {
    return JSON.parse(read(path))
  } catch {
    return null
  }
}

/**
 * Before launch, for a scenario that installs its own build: is the source (provenance or a clean checkout) acceptable for the
 * zip the harness hashed itself? The receipt does not exist yet, so only `resolveSource` can be checked.
 * @param {{ provenancePath?: string | null, installerSha256?: string | null, runId: string, cwd?: string, deps?: { read?: (p: string) => string, run?: typeof runTool } }} args
 * @returns {{ problems: string[] }}
 */
export function preflightSource({
  provenancePath = null,
  installerSha256 = null,
  runId,
  cwd = HARNESS_CHECKOUT,
  deps = {}
}) {
  const read = deps.read ?? ((path) => readFileSync(path, 'utf8'))
  const provenance = provenancePath ? readJsonOrNull(provenancePath, read) : null
  if (provenancePath && !provenance) return { problems: ['--provenance is not readable JSON'] }
  return resolveSource({
    provenance,
    local: provenance ? null : readLocalSource(cwd, deps.run),
    installerSha256,
    runId
  })
}

/**
 * Read the receipt, hash the app, resolve the source, bind. `expectedInstallerSha256` (a --zip or --candidate-zip the harness hashed
 * itself) must equal the receipt's, so a receipt left over from another zip cannot be bound to this run.
 * @param {{ appPath: string, receiptDir: string, provenancePath?: string | null, runId: string, expectedInstallerSha256?: string | null, cwd?: string, deps?: { read?: (p: string) => string, run?: typeof runTool, hash?: typeof sha256File } }} args
 */
export function bindRun({
  appPath,
  receiptDir,
  provenancePath = null,
  runId,
  expectedInstallerSha256 = null,
  cwd = HARNESS_CHECKOUT,
  deps = {}
}) {
  const read = deps.read ?? ((path) => readFileSync(path, 'utf8'))
  const installReceipt = readJsonOrNull(join(receiptDir, 'install-receipt.json'), read)
  const provenance = provenancePath ? readJsonOrNull(provenancePath, read) : null
  if (provenancePath && !provenance) return { binding: null, problems: ['--provenance is not readable JSON'] }
  const result = bindArtifact({
    installReceipt,
    appHash: appAsarSha256(appPath, deps.hash),
    provenance,
    local: provenance ? null : readLocalSource(cwd, deps.run),
    runId
  })
  if (result.binding && expectedInstallerSha256 && result.binding.installerSha256 !== expectedInstallerSha256)
    return { binding: null, problems: ['the install receipt is for a different zip than the one this run was given'] }
  return result
}

/** Problems with an already-built binding (a report read back from disk). Empty means well-formed. */
export function bindingProblems(binding) {
  if (!binding || typeof binding !== 'object') return ['the report has no binding block']
  const problems = []
  if (!HEX40.test(binding.commit ?? '')) problems.push('binding.commit is not a 40-hex commit')
  for (const key of ['installerSha256', 'appHash', 'mainExecutableSha256'])
    if (!HEX64.test(binding[key] ?? '')) problems.push(`binding.${key} is not a sha256`)
  if (!['provenance', 'local-asserted'].includes(binding.bindingSource))
    problems.push('binding.bindingSource is unknown')
  if (binding.run?.kind === 'hosted') {
    if (!Number.isInteger(binding.run.id) || binding.run.id <= 0)
      problems.push('binding.run.id is not a positive integer')
    if (binding.bindingSource !== 'provenance') problems.push('a hosted run must be bound by provenance')
  } else if (binding.run?.kind === 'local') {
    if (typeof binding.run.runId !== 'string' || binding.run.runId.length === 0)
      problems.push('binding.run.runId is empty')
    if (binding.bindingSource !== 'local-asserted') problems.push('a local run is local-asserted')
  } else problems.push('binding.run.kind is unknown')
  return problems
}

/** True when every binding names the same commit, installer and app hash. Returns the first disagreement otherwise. */
export function bindingsAgree(bindings) {
  if (bindings.length === 0) return { agree: true, disagreement: null }
  const [first, ...rest] = bindings
  for (const key of ['commit', 'installerSha256', 'appHash'])
    for (const other of rest)
      if (other[key] !== first[key]) return { agree: false, disagreement: `${key} differs between reports` }
  return { agree: true, disagreement: null }
}
