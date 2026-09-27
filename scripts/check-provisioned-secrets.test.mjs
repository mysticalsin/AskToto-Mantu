// check-provisioned-secrets.test.mjs — dependency-free node:test suite for the release-build gate that
// unifies the operator skill-pack and license-lease "provisioned resource or committed DEV placeholder"
// families (ticket M2-0056). Run directly with `node --test scripts/check-provisioned-
// secrets.test.mjs`; scripts/check-provisioned-secrets.test.ts spawns this same file so `npm test` covers
// it too (vitest's scripts/**/*.{test,spec}.{ts,tsx} include glob never sees a bare .test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { checkProvisionedPublicKey, readDevPlaceholder } from './lib/provisioned-secret.mjs'
import { runCheck } from './check-provisioned-secrets.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = join(HERE, 'check-provisioned-secrets.mjs')

// The real committed DEV placeholders (operator-skill-key.ts / license-lease-key.ts). Pinned here as a
// literal so a test that reads them via readDevPlaceholder() has something independent to compare against.
const REAL_OPERATOR_PLACEHOLDER = '0782eTCPPOCzxP6yQ_LT8qcXS_t7vE-eDh_DpLf0cV0'
const REAL_LEASE_PLACEHOLDER = 'FzzE8mBXkx36otsurVczzedp9q1_KqGZHYtHbnZOuTY'

// runCheck's own resourcePath layout, mirrored here so a fixture directory looks exactly like a real
// packaging staging root: <resourcesDir>/operator/pubkey.json, <resourcesDir>/license-lease/pubkey.json.
const FAMILY_DIRS = { operator: 'operator', 'license-lease': 'license-lease' }
const FAMILY_PLACEHOLDERS = { operator: REAL_OPERATOR_PLACEHOLDER, 'license-lease': REAL_LEASE_PLACEHOLDER }

function tempFixtureDir() {
  return mkdtempSync(join(tmpdir(), 'metis-provisioned-secret-'))
}

function writePubkey(dir, name, publicKey) {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify({ algorithm: 'ed25519', publicKey }))
  return path
}

/** Writes (or omits) <resourcesDir>/<family>/pubkey.json in one of runCheck's four observable shapes. */
function writeFamilyResource(resourcesDir, family, status) {
  if (status === 'missing') return
  const dir = join(resourcesDir, FAMILY_DIRS[family])
  mkdirSync(dir, { recursive: true })
  if (status === 'unreadable') {
    writeFileSync(join(dir, 'pubkey.json'), '{ not valid json')
    return
  }
  const publicKey = status === 'placeholder' ? FAMILY_PLACEHOLDERS[family] : `a-real-provisioned-${family}-key`
  writeFileSync(join(dir, 'pubkey.json'), JSON.stringify({ algorithm: 'ed25519', publicKey }))
}

function withTempDir(fn) {
  const dir = tempFixtureDir()
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- checkProvisionedPublicKey (present / missing / placeholder + robustness) ---------------------

test('checkProvisionedPublicKey: "provisioned" when the resource carries a real, distinct key', () => {
  withTempDir((dir) => {
    const resourcePath = writePubkey(dir, 'pubkey.json', 'a-real-production-key-not-the-placeholder')
    const result = checkProvisionedPublicKey({ resourcePath, placeholder: 'dev-placeholder-key' })
    assert.equal(result.status, 'provisioned')
  })
})

test('checkProvisionedPublicKey: "missing" when no resource file exists at all', () => {
  withTempDir((dir) => {
    const result = checkProvisionedPublicKey({
      resourcePath: join(dir, 'pubkey.json'),
      placeholder: 'dev-placeholder-key'
    })
    assert.equal(result.status, 'missing')
  })
})

test('checkProvisionedPublicKey: "placeholder" when the resource still equals the committed DEV key', () => {
  withTempDir((dir) => {
    const resourcePath = writePubkey(dir, 'pubkey.json', 'dev-placeholder-key')
    const result = checkProvisionedPublicKey({ resourcePath, placeholder: 'dev-placeholder-key' })
    assert.equal(result.status, 'placeholder')
  })
})

test('checkProvisionedPublicKey: "unreadable" for malformed JSON', () => {
  withTempDir((dir) => {
    const resourcePath = join(dir, 'pubkey.json')
    writeFileSync(resourcePath, '{ not valid json')
    const result = checkProvisionedPublicKey({ resourcePath, placeholder: 'dev-placeholder-key' })
    assert.equal(result.status, 'unreadable')
  })
})

test('checkProvisionedPublicKey: "unreadable" when publicKey is absent or not a string', () => {
  withTempDir((dir) => {
    const resourcePath = join(dir, 'pubkey.json')
    writeFileSync(resourcePath, JSON.stringify({ algorithm: 'ed25519', publicKey: 42 }))
    const result = checkProvisionedPublicKey({ resourcePath, placeholder: 'dev-placeholder-key' })
    assert.equal(result.status, 'unreadable')
  })
})

// --- readDevPlaceholder (reads the literal straight out of the .ts source, no TS loader) ----------

test('readDevPlaceholder: reads the real DEV_OPERATOR_PUBLIC_KEY out of operator-skill-key.ts', () => {
  const sourcePath = join(HERE, '..', 'src', 'main', 'operator-skill-key.ts')
  assert.equal(readDevPlaceholder(sourcePath, 'DEV_OPERATOR_PUBLIC_KEY'), REAL_OPERATOR_PLACEHOLDER)
})

test('readDevPlaceholder: reads the real DEV_LEASE_PUBLIC_KEY out of license-lease-key.ts', () => {
  const sourcePath = join(HERE, '..', 'src', 'main', 'license-lease-key.ts')
  assert.equal(readDevPlaceholder(sourcePath, 'DEV_LEASE_PUBLIC_KEY'), REAL_LEASE_PLACEHOLDER)
})

test('readDevPlaceholder: throws a clear, named error when the constant cannot be found', () => {
  withTempDir((dir) => {
    const sourcePath = join(dir, 'empty.ts')
    writeFileSync(sourcePath, 'export const NOTHING_HERE = 1\n')
    assert.throws(() => readDevPlaceholder(sourcePath, 'DEV_MISSING_KEY'), /DEV_MISSING_KEY/)
  })
})

// --- runCheck (the release-profile gate, called directly with a fixture resourcesDir) -----------------
//
// Table-driven over both families × every non-"provisioned" status checkProvisionedPublicKey can report:
// each one is the identical unsafe outcome (the app falls back to its DEV_* key), so each must FAIL a
// release-profile build on its own, regardless of what the other family looks like.

const FAILING_STATUSES = ['missing', 'placeholder', 'unreadable']

for (const family of Object.keys(FAMILY_DIRS)) {
  for (const status of FAILING_STATUSES) {
    test(`runCheck: FAILs release profile when the ${family} resource is ${status} (other family provisioned)`, () => {
      withTempDir((resourcesDir) => {
        for (const other of Object.keys(FAMILY_DIRS)) {
          writeFamilyResource(resourcesDir, other, other === family ? status : 'provisioned')
        }
        const code = runCheck({ profile: 'release', dryRun: false, resourcesDir })
        assert.equal(code, 1)
      })
    })
  }
}

test('runCheck: OK once both families are genuinely provisioned', () => {
  withTempDir((resourcesDir) => {
    writeFamilyResource(resourcesDir, 'operator', 'provisioned')
    writeFamilyResource(resourcesDir, 'license-lease', 'provisioned')
    const code = runCheck({ profile: 'release', dryRun: false, resourcesDir })
    assert.equal(code, 0)
  })
})

// The most common real case: the first release attempt after this gate merges, with nothing provisioned
// yet. Both families fail together, so the operator reading the FAIL output needs the fix path for both
// on the same run — not just the first one, with the second only surfacing on their next attempt.
test('runCheck: FAIL hint names every unprovisioned family, not just the first', () => {
  withTempDir((resourcesDir) => {
    writeFamilyResource(resourcesDir, 'operator', 'missing')
    writeFamilyResource(resourcesDir, 'license-lease', 'missing')
    const operatorPath = join(resourcesDir, 'operator', 'pubkey.json')
    const leasePath = join(resourcesDir, 'license-lease', 'pubkey.json')

    const originalError = console.error
    const stderrLines = []
    console.error = (...args) => stderrLines.push(args.join(' '))
    let code
    try {
      code = runCheck({ profile: 'release', dryRun: false, resourcesDir })
    } finally {
      console.error = originalError
    }
    const stderr = stderrLines.join('\n')

    assert.equal(code, 1)
    assert.ok(stderr.includes(operatorPath), `expected the FAIL hint to name ${operatorPath}:\n${stderr}`)
    assert.ok(stderr.includes(leasePath), `expected the FAIL hint to name ${leasePath}:\n${stderr}`)
  })
})

test('runCheck: dev profile never fails, even with both resources missing', () => {
  withTempDir((resourcesDir) => {
    const code = runCheck({ profile: 'dev', dryRun: false, resourcesDir })
    assert.equal(code, 0)
  })
})

test('runCheck: --dry-run never fails release profile, even with a placeholder present', () => {
  withTempDir((resourcesDir) => {
    writeFamilyResource(resourcesDir, 'operator', 'placeholder')
    writeFamilyResource(resourcesDir, 'license-lease', 'placeholder')
    const code = runCheck({ profile: 'release', dryRun: true, resourcesDir })
    assert.equal(code, 0)
  })
})

// --- CLI (end-to-end subprocess, exercising the exact invocation shape release:build:* uses) ---------
//
// runCheck no longer accepts a resourcesDir override from the CLI (production always inspects the exact
// files electron-builder.yml packages), so these exercise argument parsing and exit-code mapping only,
// against the real checkout: resources/operator/ and resources/license-lease/ are real, tracked,
// .gitkeep-only directories with no pubkey.json, so a release-profile run here is deterministically
// "missing" for both families, exactly like a plain clone.

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', timeout: 10_000 })
}

test('CLI: --profile release exits 1 against the real checkout (resources/* are not provisioned)', () => {
  const result = runCli(['--profile', 'release'])
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
})

test('CLI: --profile release --dry-run exits 0 even though the real checkout is not provisioned', () => {
  const result = runCli(['--profile', 'release', '--dry-run'])
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('CLI: rejects an unrecognized --profile value with a usage error (exit 2)', () => {
  const result = runCli(['--profile', 'staging'])
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
})
