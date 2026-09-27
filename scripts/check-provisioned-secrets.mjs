#!/usr/bin/env node
// check-provisioned-secrets.mjs — the release-build gate for every embedded-credential family that falls
// back to a committed DEV placeholder key when packaging did not provision the real thing
// (L05-F1, L05-F7, L05-REFACTOR-1). A release build that ships src/main/operator-skill-key.ts's or
// src/main/license-lease-key.ts's DEV_* fallback is trusting a public key with no matching private half
// this project controls — every packaged skill-pack signature check, and every offline license lease,
// would verify against a key anyone who clones this repo can find.
//
// ONE gate, via the shared helper scripts/lib/provisioned-secret.mjs, covers both families that share
// this exact "provisioned resource, or committed DEV placeholder" shape:
//   1. operator skill-pack public key  — <resources>/operator/pubkey.json       (src/main/operator-skill-key.ts)
//   2. license-lease public key        — <resources>/license-lease/pubkey.json  (src/main/license-lease-key.ts)
//
// The embedded Cloudflare proxy key and the Cahê package key are DELIBERATELY out of this gate: both are
// opt-in credentials with no committed DEV placeholder to fall back to, so a keyless build is already a
// valid release for them. Their own invariants are enforced post-pack, against the packaged app, by
// scripts/check-embedded-cloudflare-key.mjs and scripts/check-cahe-package.mjs respectively.
//
// Usage:
//   node scripts/check-provisioned-secrets.mjs --profile <dev|release> [--dry-run]
//
//   --profile release   FAIL (exit 1) if the operator or license-lease family is missing OR still the
//                        committed DEV placeholder. This is what release:build:mac / release:build:win /
//                        release:mas / release:win:store run.
//   --profile dev        (default) report status only, exit 0 regardless — a plain dev checkout is
//                        SUPPOSED to fall back to the placeholders.
//   --dry-run            print the same report a real run would, but never exit non-zero. Safe to run
//                        against a checkout with no provisioned resources at all (a contributor's
//                        machine, CI) to smoke-test this script without needing real production keys.
//
// Always checks the resources electron-builder.yml actually packages — resources/operator and
// resources/license-lease at the repo root (see resolveFamilies below) — never a path an environment
// variable could point somewhere else. That is deliberate: this gate exists to stop a release from
// shipping the DEV fallback, so it must inspect the exact files packaging will embed, not a stand-in a
// misconfigured or malicious environment substituted for them.
//
// node --test scripts/check-provisioned-secrets.test.mjs is the behavioral suite this gate depends on.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkProvisionedPublicKey, readDevPlaceholder } from './lib/provisioned-secret.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Mandatory-in-release families sharing the provisioned-resource-or-DEV-placeholder shape.
 *  @param {string} resourcesDir - the packaging staging root electron-builder.yml's extraResources reads
 *    from. Production always uses REPO_ROOT/resources (runCheck's default); a test passes a fixture
 *    directory shaped the same way instead of pointing at the real checkout. */
function resolveFamilies(resourcesDir) {
  return [
    {
      label: 'operator skill-pack public key',
      resourcePath: join(resourcesDir, 'operator', 'pubkey.json'),
      devSourcePath: join(REPO_ROOT, 'src', 'main', 'operator-skill-key.ts'),
      devConstName: 'DEV_OPERATOR_PUBLIC_KEY'
    },
    {
      label: 'license-lease public key',
      resourcePath: join(resourcesDir, 'license-lease', 'pubkey.json'),
      devSourcePath: join(REPO_ROOT, 'src', 'main', 'license-lease-key.ts'),
      devConstName: 'DEV_LEASE_PUBLIC_KEY'
    }
  ]
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
 * @param {{ profile: 'dev' | 'release', dryRun: boolean, resourcesDir?: string }} opts
 * @returns {number}
 */
export function runCheck({ profile, dryRun, resourcesDir = join(REPO_ROOT, 'resources') }) {
  let anyMandatoryFailure = false
  let firstFailingFamily = null

  for (const family of resolveFamilies(resourcesDir)) {
    const placeholder = readDevPlaceholder(family.devSourcePath, family.devConstName)
    const result = checkProvisionedPublicKey({ resourcePath: family.resourcePath, placeholder })
    const mandatoryFailure = result.status !== 'provisioned'
    if (mandatoryFailure) {
      anyMandatoryFailure = true
      firstFailingFamily ??= family
    }
    const tag = mandatoryFailure ? (profile === 'release' ? 'FAIL' : 'WARN') : 'OK'
    console.log(`[check:provisioned-secrets] ${tag} — ${family.label}: ${result.message}`)
  }

  const shouldFail = profile === 'release' && anyMandatoryFailure
  if (shouldFail && dryRun) {
    console.log('[check:provisioned-secrets] DRY RUN — the FAIL above would stop a real release-profile build; exiting 0 anyway.')
    return 0
  }
  if (shouldFail) {
    console.error(
      '[check:provisioned-secrets] FAIL — release profile requires the operator and license-lease families to ' +
        'both be provisioned, not the committed DEV placeholder. See FAIL lines above. Fix: write the shape ' +
        `{ "algorithm": "ed25519", "publicKey": "<base64url>" } to ${firstFailingFamily.resourcePath} — for ` +
        'license-lease that JSON is exactly the body GET /license/pubkey returns.'
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
