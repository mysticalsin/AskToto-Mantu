#!/usr/bin/env node
// lean-release.mjs — build one lean release installer set (G11).
//
//   node scripts/lean-release.mjs <mac|win> <arm64|x64> [--qa-identity] [--dry-run]
//   npm run dist:lean -- mac arm64
//
// Runs the plan in scripts/lib/lean-release-plan.mjs: embed, provision, compile with the lean profile, package
// unsigned, check the embedded blobs in the package, measure, then move the installers to release/ for
// scripts/qa/provenance.mjs. It never signs with a Developer ID, publishes or tags. The lean profile and exact
// architecture are pinned per step, so an exported METIS_PACKAGE_PROFILE cannot change what is built.
import { spawn } from 'node:child_process'
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RELEASE_PACKAGE_PROFILE, formatStep, leanReleasePlan, parseLeanReleaseArgs } from './lib/lean-release-plan.mjs'

/** Move the top-level installers (never an unpacked app tree) out of a per-architecture output directory. */
export async function collectInstallers({ from, to, pattern }) {
  const matcher = new RegExp(pattern, 'i')
  const names = (await readdir(from, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && matcher.test(entry.name) && !entry.name.endsWith('.blockmap'))
    .map((entry) => entry.name)
  if (names.length === 0) throw new Error(`The lean build produced no installer in ${from}`)
  await mkdir(to, { recursive: true })
  for (const name of names) await rename(join(from, name), join(to, name))
  return names
}

function spawnStep(command, args, env) {
  return new Promise((resolve) => {
    // Windows resolves npm and npx through their .cmd shims, which need a shell; arguments are fixed strings.
    const child = spawn(command, args, { env, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

export async function runLeanRelease(plan, options = {}) {
  const log = options.log ?? console.log
  const env = options.env ?? process.env
  const run = options.spawnStep ?? spawnStep
  const collect = options.collect ?? collectInstallers
  for (const [index, step] of plan.steps.entries()) {
    const label = `[lean-release] step=${index + 1}/${plan.steps.length} name="${step.name}" command="${formatStep(step)}"`
    log(label)
    if (options.dryRun) continue
    if (step.collect) {
      const moved = await collect(step.collect)
      log(`[lean-release] moved ${moved.join(', ')}`)
      continue
    }
    const code = await run(step.command, step.args, {
      ...env,
      METIS_PACKAGE_PROFILE: RELEASE_PACKAGE_PROFILE,
      ...(step.env ?? {})
    })
    if (code !== 0) {
      log(`[lean-release] FAILED step=${index + 1} name="${step.name}" exitCode=${code}`)
      return code
    }
  }
  return 0
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const parsed = parseLeanReleaseArgs(process.argv.slice(2))
    process.exitCode = await runLeanRelease(leanReleasePlan(parsed), { dryRun: parsed.dryRun })
  } catch (error) {
    console.error(`[lean-release] ${error.message}`)
    process.exitCode = 2
  }
}
