// provisioned-secret.mjs — a build-time check for one invariant: a packaged public-key resource
// (`<resourcesDir>/<family>/pubkey.json`, written by electron-builder's extraResources at packaging time)
// must exist, parse as JSON, carry a string `publicKey`, and differ from the committed DEV placeholder
// constant the app falls back to at runtime when that resource is absent. Used by
// scripts/check-provisioned-secrets.mjs (ticket M2-0056) for the two credential families that share this
// exact shape today — src/main/operator-skill-key.ts's DEV_OPERATOR_PUBLIC_KEY and
// src/main/license-lease-key.ts's DEV_LEASE_PUBLIC_KEY. Neither runtime module imports this file; each
// declares its own placeholder constant and reads its own resource, and this helper only checks, at build
// time, that packaging provisioned something else in its place.
import { existsSync, readFileSync } from 'node:fs'

/**
 * Read a `const NAME = '...'` string literal straight out of a TypeScript source file, with no TS loader
 * (plain `node` cannot import a .ts file). Same technique check-cloudflare-key-valid.mjs already uses for
 * METIS_WORKER_URL / the Cloudflare default model, for the same reason: the placeholder this gate compares
 * against must never drift from the value the app actually falls back to at runtime.
 * @param {string} sourcePath - absolute path to the .ts file that declares the constant
 * @param {string} constName - the exact identifier, e.g. "DEV_OPERATOR_PUBLIC_KEY"
 * @returns {string}
 */
export function readDevPlaceholder(sourcePath, constName) {
  const source = readFileSync(sourcePath, 'utf8')
  const match = source.match(new RegExp(`const ${constName} = '([^']+)'`))
  if (!match) {
    throw new Error(`could not read ${constName} out of ${sourcePath} — has its declaration changed shape?`)
  }
  return match[1]
}

/**
 * Compare a build-provisioned public-key resource against its committed DEV placeholder.
 * @param {{ resourcePath: string, placeholder: string }} opts
 * @returns {{ status: 'provisioned' | 'missing' | 'unreadable' | 'placeholder', message: string }}
 */
export function checkProvisionedPublicKey({ resourcePath, placeholder }) {
  if (!existsSync(resourcePath)) {
    return { status: 'missing', message: `not provisioned — no file at ${resourcePath}` }
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(resourcePath, 'utf8'))
  } catch (e) {
    return { status: 'unreadable', message: `${resourcePath} is not readable JSON (${e.message})` }
  }

  const publicKey = typeof parsed?.publicKey === 'string' ? parsed.publicKey : ''
  if (!publicKey) {
    return { status: 'unreadable', message: `${resourcePath} has no "publicKey" string` }
  }
  if (publicKey === placeholder) {
    return { status: 'placeholder', message: `${resourcePath} still carries the committed DEV placeholder key` }
  }
  return { status: 'provisioned', message: `provisioned at ${resourcePath}` }
}
