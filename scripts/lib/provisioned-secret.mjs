// provisioned-secret.mjs — the ONE helper behind every "read a build-provisioned public-key resource, or
// fall back to a committed DEV placeholder" credential family (src/main/operator-skill-key.ts,
// src/main/license-lease-key.ts — L05-F1, L05-F7, L05-REFACTOR-1). Both modules document the SAME
// contract: a JSON resource shaped `{ algorithm, publicKey }`, provisioned by electron-builder's
// extraResources at packaging time; absent that file, the app trusts a public key anyone who clones this
// repo can find. checkProvisionedPublicKey() answers "did packaging actually provision the real thing, or
// is this build about to ship the placeholder?" once, instead of three separate
// existsSync/JSON.parse/placeholder-compare call sites.
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
