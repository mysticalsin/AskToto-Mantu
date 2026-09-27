#!/usr/bin/env node
// check-provisioned-secrets.mjs — the release-build gate for every embedded-credential family that falls
// back to a committed DEV placeholder key when packaging did not provision the real thing
// (L05-F1, L05-F7, L05-REFACTOR-1). A release build that ships src/main/operator-skill-key.ts's or
// src/main/license-lease-key.ts's DEV_* fallback is trusting a public key with no matching private half
// this project controls — every packaged skill-pack signature check, and every offline license lease,
// would verify against a key anyone who clones this repo can find.
//
// ONE gate now covers both families that share this exact shape, via scripts/lib/provisioned-secret.mjs:
//   1. operator skill-pack public key  — resources/operator/pubkey.json       (src/main/operator-skill-key.ts)
//   2. license-lease public key        — resources/license-lease/pubkey.json  (src/main/license-lease-key.ts)
//
// The embedded Cloudflare proxy key (src/main/embedded-cloudflare-key.ts) is a THIRD build-provisioned
// credential family but does not share this shape — it is opt-in (METIS_EMBED_CLOUDFLARE_KEY=1) rather
// than mandatory, ships AES-256-GCM encrypted rather than as a plain public key, and its gate
// (scripts/check-embedded-cloudflare-key.mjs) runs POST-pack against the packaged app, which does not
// exist yet when this pre-pack script runs. This script reports its local provisioning intent for
// one-command visibility across all three families, but never gates release on it — that stays
// check-embedded-cloudflare-key.mjs's job.
//
// Usage:
//   node scripts/check-provisioned-secrets.mjs --profile <dev|release> [--dry-run]
//
//   --profile release   FAIL (exit 1) if the operator or license-lease family is missing OR still the
//                        committed DEV placeholder. This is what release:build:mac / release:build:win run.
//   --profile dev        (default) report status only, exit 0 regardless — a plain dev checkout is
//                        SUPPOSED to fall back to the placeholders.
//   --dry-run            print the same report a real run would, but never exit non-zero. Safe to run
//                        against a checkout with no provisioned resources at all (a contributor's
//                        machine, CI) to smoke-test this script without needing real production keys.
//
// node --test scripts/check-provisioned-secrets.test.mjs is the behavioral suite this gate depends on.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkProvisionedPublicKey, readDevPlaceholder } from './lib/provisioned-secret.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Mandatory-in-release families sharing the provisioned-resource-or-DEV-placeholder shape. Resource
 *  paths are overridable via env for tests only — production always uses the packaging-time default. */
function resolveFamilies(env) {
  return [
    {
      label: 'operator skill-pack public key',
      resourcePath: env.METIS_OPERATOR_PUBKEY_PATH || join(REPO_ROOT, 'resources', 'operator', 'pubkey.json'),
      devSourcePath: join(REPO_ROOT, 'src', 'main', 'operator-skill-key.ts'),
      devConstName: 'DEV_OPERATOR_PUBLIC_KEY'
    },
    {
      label: 'license-lease public key',
      resourcePath: env.METIS_LICENSE_LEASE_PUBKEY_PATH || join(REPO_ROOT, 'resources', 'license-lease', 'pubkey.json'),
      devSourcePath: join(REPO_ROOT, 'src', 'main', 'license-lease-key.ts'),
      devConstName: 'DEV_LEASE_PUBLIC_KEY'
    }
  ]
}

function resolveCloudflareBundlePath(env) {
  return env.METIS_CLOUDFLARE_EMBED_PATH || join(REPO_ROOT, 'build', 'cloudflare-embed', 'key.json')
}

function parseArgs(argv) {
  let profile = 'dev'
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile') {
      profile = argv[++i]
    } else if (argv[i] === '--dry-run') {
      dryRun = true
    } else {
      throw new Error(`unrecognized argument: ${argv[i]}`)
    }
  }
  if (profile !== 'dev' && profile !== 'release') {
    throw new Error(`--profile must be "dev" or "release", got "${profile}"`)
  }
  return { profile, dryRun }
}

/**
 * Runs the full report + gate and returns the exit code, without calling process.exit — kept pure so the
 * test suite (and, in principle, another script) can drive it directly instead of only via a subprocess.
 * @param {{ profile: 'dev' | 'release', dryRun: boolean, env?: Record<string, string | undefined> }} opts
 * @returns {number}
 */
export function runCheck({ profile, dryRun, env = process.env }) {
  let anyMandatoryFailure = false

  for (const family of resolveFamilies(env)) {
    const placeholder = readDevPlaceholder(family.devSourcePath, family.devConstName)
    const result = checkProvisionedPublicKey({ resourcePath: family.resourcePath, placeholder })
    const mandatoryFailure = result.status !== 'provisioned'
    if (mandatoryFailure) anyMandatoryFailure = true
    const tag = mandatoryFailure ? (profile === 'release' ? 'FAIL' : 'WARN') : 'OK'
    console.log(`[check:provisioned-secrets] ${tag} — ${family.label}: ${result.message}`)
  }

  if (existsSync(resolveCloudflareBundlePath(env))) {
    console.log(
      '[check:provisioned-secrets] INFO — embedded Cloudflare key intended for this build; gated separately, post-pack, by scripts/check-embedded-cloudflare-key.mjs.'
    )
  } else {
    console.log('[check:provisioned-secrets] INFO — no embedded Cloudflare key bundle (normal keyless build).')
  }

  const shouldFail = profile === 'release' && anyMandatoryFailure
  if (shouldFail && dryRun) {
    console.log('[check:provisioned-secrets] DRY RUN — the FAIL above would stop a real release-profile build; exiting 0 anyway.')
    return 0
  }
  if (shouldFail) {
    console.error(
      '[check:provisioned-secrets] FAIL — release profile requires the operator and license-lease families to both be provisioned, not the committed DEV placeholder. See FAIL lines above.'
    )
    return 1
  }
  console.log(`[check:provisioned-secrets] OK — profile=${profile}${dryRun ? ' (dry-run)' : ''}`)
  return 0
}

// Only run as a CLI when invoked directly, e.g. `node scripts/check-provisioned-secrets.mjs ...` — not
// when the test suite imports runCheck() to drive it with fixture paths.
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`[check:provisioned-secrets] ${e.message}`)
    console.error('Usage: node scripts/check-provisioned-secrets.mjs --profile <dev|release> [--dry-run]')
    process.exit(2)
  }
  process.exit(runCheck(options))
}
