// check-provisioned-secrets.test.mjs — dependency-free node:test suite for the release-build gate that
// unifies the operator skill-pack and license-lease "provisioned resource or committed DEV placeholder"
// families (L05-F1, L05-F7, L05-REFACTOR-1). Run directly with `node --test scripts/check-provisioned-
// secrets.test.mjs`; scripts/check-provisioned-secrets.test.ts spawns this same file so `npm test` covers
// it too (vitest's scripts/**/*.{test,spec}.{ts,tsx} include glob never sees a bare .test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function tempFixtureDir() {
  return mkdtempSync(join(tmpdir(), 'metis-provisioned-secret-'))
}

function writePubkey(dir, name, publicKey) {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify({ algorithm: 'ed25519', publicKey }))
  return path
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

// --- runCheck (the release-profile gate, called directly with an injected env) ----------------------

test('runCheck: FAILs release profile when the operator resource is still the committed DEV key', () => {
  withTempDir((dir) => {
    const operatorPath = writePubkey(dir, 'operator-pubkey.json', REAL_OPERATOR_PLACEHOLDER)
    const leasePath = writePubkey(dir, 'lease-pubkey.json', 'a-real-provisioned-lease-key')
    const code = runCheck({
      profile: 'release',
      dryRun: false,
      env: { METIS_OPERATOR_PUBKEY_PATH: operatorPath, METIS_LICENSE_LEASE_PUBKEY_PATH: leasePath }
    })
    assert.equal(code, 1)
  })
})

test('runCheck: FAILs release profile when the license-lease resource is missing', () => {
  withTempDir((dir) => {
    const operatorPath = writePubkey(dir, 'operator-pubkey.json', 'a-real-provisioned-operator-key')
    const code = runCheck({
      profile: 'release',
      dryRun: false,
      env: {
        METIS_OPERATOR_PUBKEY_PATH: operatorPath,
        METIS_LICENSE_LEASE_PUBKEY_PATH: join(dir, 'never-written.json')
      }
    })
    assert.equal(code, 1)
  })
})

test('runCheck: OK once both families are genuinely provisioned', () => {
  withTempDir((dir) => {
    const operatorPath = writePubkey(dir, 'operator-pubkey.json', 'a-real-provisioned-operator-key')
    const leasePath = writePubkey(dir, 'lease-pubkey.json', 'a-real-provisioned-lease-key')
    const code = runCheck({
      profile: 'release',
      dryRun: false,
      env: { METIS_OPERATOR_PUBKEY_PATH: operatorPath, METIS_LICENSE_LEASE_PUBKEY_PATH: leasePath }
    })
    assert.equal(code, 0)
  })
})

test('runCheck: dev profile never fails, even with both resources missing', () => {
  withTempDir((dir) => {
    const code = runCheck({
      profile: 'dev',
      dryRun: false,
      env: {
        METIS_OPERATOR_PUBKEY_PATH: join(dir, 'missing-operator.json'),
        METIS_LICENSE_LEASE_PUBKEY_PATH: join(dir, 'missing-lease.json')
      }
    })
    assert.equal(code, 0)
  })
})

test('runCheck: --dry-run never fails release profile, even with a placeholder present', () => {
  withTempDir((dir) => {
    const operatorPath = writePubkey(dir, 'operator-pubkey.json', REAL_OPERATOR_PLACEHOLDER)
    const leasePath = writePubkey(dir, 'lease-pubkey.json', REAL_LEASE_PLACEHOLDER)
    const code = runCheck({
      profile: 'release',
      dryRun: true,
      env: { METIS_OPERATOR_PUBKEY_PATH: operatorPath, METIS_LICENSE_LEASE_PUBKEY_PATH: leasePath }
    })
    assert.equal(code, 0)
  })
})

// --- CLI (end-to-end subprocess, exercising the exact invocation shape release:build:* uses) --------

function runCli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, ...extraEnv }
  })
}

test('CLI: --profile release --dry-run always exits 0, even against a plain checkout with no provisioned resources', () => {
  const result = runCli(['--profile', 'release', '--dry-run'], {
    METIS_OPERATOR_PUBKEY_PATH: '',
    METIS_LICENSE_LEASE_PUBKEY_PATH: ''
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('CLI: no flags (dev profile default) exits 0 even when both resources are missing', () => {
  const result = runCli([], { METIS_OPERATOR_PUBKEY_PATH: '', METIS_LICENSE_LEASE_PUBKEY_PATH: '' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
})

test('CLI: --profile release exits 1 when a provisioned resource is missing', () => {
  withTempDir((dir) => {
    const result = runCli(['--profile', 'release'], {
      METIS_OPERATOR_PUBKEY_PATH: join(dir, 'missing-operator.json'),
      METIS_LICENSE_LEASE_PUBKEY_PATH: join(dir, 'missing-lease.json')
    })
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`)
  })
})

test('CLI: --profile release exits 0 once both families are genuinely provisioned', () => {
  withTempDir((dir) => {
    const operatorPath = writePubkey(dir, 'operator-pubkey.json', 'a-real-production-operator-key')
    const leasePath = writePubkey(dir, 'lease-pubkey.json', 'a-real-production-lease-key')
    const result = runCli(['--profile', 'release'], {
      METIS_OPERATOR_PUBKEY_PATH: operatorPath,
      METIS_LICENSE_LEASE_PUBKEY_PATH: leasePath
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  })
})

test('CLI: rejects an unrecognized --profile value with a usage error (exit 2)', () => {
  const result = runCli(['--profile', 'staging'])
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`)
})
