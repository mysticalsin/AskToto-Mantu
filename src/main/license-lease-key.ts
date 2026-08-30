/**
 * license-lease-key.ts — bundles the license server's Ed25519 LEASE PUBLIC KEY into the client, so
 * `verifyLease()` (license.ts) can check a signed offline lease with zero network calls.
 *
 * Reuses the SHAPE of embedded-cloudflare-key.ts (a credential provisioned at build time, read from a
 * packaged resource at runtime) but is much simpler, for one reason the license server's own README
 * says outright: "bundle that into the desktop client; a public key needs no encryption." There is
 * nothing to decrypt here, nothing to obfuscate, and nothing sensitive about this file's contents — a
 * public key's entire job is to be given to everyone who needs to verify a signature. It is safe to
 * commit to source, safe to print in a bug report, and safe to diff in a PR.
 *
 * TWO SOURCES, in priority order:
 *
 *   1. `resources/license-lease/pubkey.json` — an operator-provisioned file, written at BUILD time
 *      (electron-builder `extraResources`, the same packaging mechanism `embedded-cloudflare-key.ts`'s
 *      blob rides). Content: `{ "algorithm": "ed25519", "publicKey": "<base64url>" }` — exactly the
 *      shape `GET /license/pubkey` returns, so an operator can literally copy that response's body
 *      into this file (or run `license-server`'s `npm run generate-lease-keypair` and paste its printed
 *      public key). Absent in a plain dev checkout and in any build that hasn't wired real licensing up
 *      yet — see `embeddedLicenseLeasePubkeyAvailable()` below.
 *
 *   2. `DEV_LEASE_PUBLIC_KEY` below — a placeholder key pair generated once for this repository, purely
 *      so the lease-verification CODE PATH has something real (a syntactically and cryptographically
 *      valid Ed25519 public key) to run against in dev, in CI, and in tests, without requiring a real
 *      license server to be deployed first. Its matching PRIVATE key is NOT committed anywhere in this
 *      app's shipped source — it lives only in test fixtures that need to sign a lease to exercise
 *      `verifyLease()` (see `license.test.ts` / `license-lease-verify.test.ts`).
 *
 * THIS MUST NEVER BE TREATED AS PRODUCTION-TRUSTWORTHY: anyone who clones this repository can find
 * `DEV_LEASE_PUBLIC_KEY` and, if they also had (or generated their own) matching private key, mint a
 * "valid" lease against it. That is fine for a dev key whose only job is exercising the verify code path
 * — it is not fine for a real customer's license gate. Before actually turning `LICENSE_ENFORCEMENT` on
 * for real users, provision source (1) with the real production key pair's public half and confirm
 * `embeddedLicenseLeasePubkeyAvailable()` reports true in that build.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainLog } from './logger'

export const LICENSE_LEASE_ALGORITHM = 'ed25519'

// Dev/test-only placeholder Ed25519 public key (raw 32 bytes, base64url — the JWK `x` value, same
// encoding `GET /license/pubkey` and `publicKeyToRaw()` in license-server/lib/lease.mjs use). Generated
// once via `node -e "console.log(require('node:crypto').generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x)"`.
// See the file header above for why this is safe to ship unencrypted and NOT safe to treat as a real
// production trust anchor.
const DEV_LEASE_PUBLIC_KEY = 'FzzE8mBXkx36otsurVczzedp9q1_KqGZHYtHbnZOuTY'

/** Absolute path of the operator-provisioned resource, when packaged (electron-builder extraResources).
 *  `process.resourcesPath` is undefined under plain `node`/vitest — guarded by the try/catch below, not
 *  by checking it here, so this stays a single code path in dev, in tests, and when packaged. */
function provisionedPubkeyPath(): string {
  return join(process.resourcesPath, 'license-lease', 'pubkey.json')
}

/** Reads the build-provisioned public key, or null when absent/unreadable/malformed. Never throws. */
function readProvisionedPubkey(): string | null {
  try {
    const p = provisionedPubkeyPath()
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, 'utf8')) as { publicKey?: unknown }
    return typeof data.publicKey === 'string' && data.publicKey ? data.publicKey : null
  } catch (e) {
    mainLog.warn('[license-lease-key] could not read the provisioned lease public key; falling back to the dev key', e)
    return null
  }
}

/** The raw base64url Ed25519 public key to verify leases against — the real production key when this
 *  build was provisioned with one, otherwise the dev/test placeholder (see the file header). Always
 *  returns SOMETHING usable; there is no "licensing disabled" state for this function to represent —
 *  that's `licenseGateEnabled` (a setting) and `LICENSE_ENFORCEMENT` (a compile-time constant), not
 *  whether a key happens to be bundled. */
export function getLicenseLeasePublicKeyRaw(): string {
  return readProvisionedPubkey() ?? DEV_LEASE_PUBLIC_KEY
}

/** True only when a REAL, build-provisioned key is present (not the dev placeholder) — the signal a
 *  release-readiness check (or a future `npm run check:release`) would use to confirm production
 *  licensing was actually wired up before shipping, distinct from "the code compiles and runs". */
export function embeddedLicenseLeasePubkeyAvailable(): boolean {
  return readProvisionedPubkey() !== null
}

/** Exposed for tests only — lets license-lease-verify tests assert against the exact bundled dev key
 *  without duplicating the literal. Not used by any runtime code path. */
export function devLeasePublicKeyForTests(): string {
  return DEV_LEASE_PUBLIC_KEY
}
