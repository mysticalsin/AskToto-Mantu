#!/usr/bin/env node
// WP14: install the QA-identity zip ("Metis-QA-<version>-*.zip" from `npm run dist:qa-identity`, under release/) into
// <sandbox-home>/Applications/ and prove what was installed. Never installs into /Applications, never launches anything.
//
//   <isolate.sh> node scripts/qa/sandbox-acceptance/install.mjs --zip release/Metis-QA-<v>-mac.zip [--replace] [--dry-run]
//
// Steps: guard the sandbox root and destination, hash the zip, `ditto -x -k` into a staging directory inside the sandbox,
// check the single .app inside is com.mantu.asktoto.qa and ad-hoc signed (read-only `codesign -dv`), move it into place, hash
// the main executable and write install-receipt.json. Exit 0 installed, 1 failed, 2 refused or bad arguments.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mainExecutableSha256, readBundleId, readBundleVersion, readCodesign } from './bundle.mjs'
import { runTool } from './exec.mjs'
import {
  assertGuards,
  assertWritableInSandbox,
  checkBundleId,
  checkSandboxRoot,
  deriveSandboxRoot,
  GuardError
} from './guard.mjs'
import { CliError, EXIT_CODES, parseCli, sha256File } from './lib.mjs'

export const CLI_SPEC = Object.freeze({
  zip: { type: 'string' },
  'sandbox-root': { type: 'string' },
  replace: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false }
})

/**
 * The only .app directory directly inside `dir`; throws when there are zero or several.
 * @param {string} dir @param {(dir: string) => string[]} [list]
 */
export function singleAppIn(dir, list = (path) => readdirSync(path)) {
  const apps = list(dir).filter((name) => name.endsWith('.app'))
  if (apps.length !== 1) throw new Error(`expected exactly one .app in the zip, found ${apps.length}`)
  return apps[0]
}

export function resolveInstallConfig(argv, env = process.env) {
  const values = parseCli(argv, CLI_SPEC)
  if (!values.zip) throw new CliError('--zip <path to the Metis-QA zip> is required')
  const sandboxRoot =
    values['sandbox-root'] ??
    env.METIS_SANDBOX_ROOT ??
    deriveSandboxRoot(env.HOME) ??
    deriveSandboxRoot(env.ASKTOTO_USERDATA)
  if (!sandboxRoot)
    throw new CliError('cannot derive the sandbox root: run through _relay/goal-loop/isolate.sh or pass --sandbox-root')
  return {
    zip: resolve(values.zip),
    sandboxRoot,
    appsDir: join(sandboxRoot, 'Applications'),
    replace: values.replace,
    dryRun: values['dry-run']
  }
}

function main(argv) {
  let config
  try {
    config = resolveInstallConfig(argv)
  } catch (error) {
    console.error(`[install] ${error.message}`)
    return EXIT_CODES.PRECONDITION
  }
  const { zip, sandboxRoot, appsDir, replace, dryRun } = config
  const root = checkSandboxRoot(sandboxRoot)
  if (!root.ok) {
    console.error(`[install] guard refused: ${root.detail}`)
    return EXIT_CODES.PRECONDITION
  }
  if (!existsSync(zip) || !statSync(zip).isFile()) {
    console.error(`[install] no such zip: ${zip}`)
    return EXIT_CODES.PRECONDITION
  }
  if (!/Metis-QA-.*\.zip$/.test(basename(zip))) {
    console.error('[install] refusing a zip that is not named Metis-QA-*.zip (the QA-identity artifact)')
    return EXIT_CODES.PRECONDITION
  }
  if (dryRun) {
    console.log(`[install] dry run: would extract ${basename(zip)} (sha256 ${sha256File(zip)}) into ${appsDir}`)
    return EXIT_CODES.PASS
  }
  const staging = join(appsDir, `.staging-${process.pid}`)
  try {
    assertWritableInSandbox(staging, sandboxRoot)
    mkdirSync(staging, { recursive: true })
    const zipSha256 = sha256File(zip)
    const extract = runTool('/usr/bin/ditto', ['-x', '-k', zip, staging], { timeoutMs: 300_000 })
    if (extract.status !== 0) throw new Error(`ditto failed (exit ${extract.status}): ${extract.stderr.slice(0, 300)}`)
    const appName = singleAppIn(staging)
    const staged = join(staging, appName)
    const bundleId = readBundleId(staged)
    const bundle = checkBundleId(bundleId)
    if (!bundle.ok) throw new GuardError(`sandbox guard refused: ${bundle.detail}`, [bundle])
    const codesign = readCodesign(staged)
    if (!codesign.adhoc) throw new Error(`the bundle is not ad-hoc signed (codesign: ${JSON.stringify(codesign)})`)
    const target = join(appsDir, appName)
    if (existsSync(target)) {
      if (!replace) throw new Error(`${target} already exists; pass --replace to overwrite it`)
      assertWritableInSandbox(target, sandboxRoot)
      rmSync(target, { recursive: true, force: true })
    }
    renameSync(staged, target)
    assertGuards({ sandboxRoot, appPath: target, bundleId: readBundleId(target), requireIsolateWrapper: false })
    const receipt = {
      schema: 'sandbox-install/1',
      installedAt: new Date().toISOString(),
      zip: { name: basename(zip), sha256: zipSha256 },
      app: {
        name: appName,
        bundleId,
        version: readBundleVersion(target),
        mainExecutableSha256: mainExecutableSha256(target)
      },
      codesign: {
        adhoc: codesign.adhoc,
        signature: codesign.signature,
        teamIdentifier: codesign.teamIdentifier,
        identifier: codesign.identifier,
        format: codesign.format
      }
    }
    writeFileSync(join(appsDir, 'install-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    console.log(`[install] installed ${appName} (${bundleId}, ad-hoc signed) into ${appsDir}`)
    console.log(`[install] zip sha256 ${receipt.zip.sha256}`)
    console.log(`[install] main executable sha256 ${receipt.app.mainExecutableSha256}`)
    return EXIT_CODES.PASS
  } catch (error) {
    console.error(`[install] ${error.message}`)
    return error instanceof GuardError ? EXIT_CODES.PRECONDITION : EXIT_CODES.FAIL
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      /* staging is inside the sandbox; a leftover is harmless */
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main(process.argv.slice(2))
