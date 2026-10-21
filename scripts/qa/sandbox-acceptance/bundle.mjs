// WP14 sandbox acceptance — read-only facts about an app bundle: identity, version, ad-hoc signature, hashes.
import { join } from 'node:path'
import { executableForApp, sha256File } from './lib.mjs'
import { runTool } from './exec.mjs'

/** @param {string} appPath @param {string} key @param {typeof runTool} [run] */
export function readPlistKey(appPath, key, run = runTool) {
  const result = run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')])
  return result.status === 0 ? result.stdout.trim() || null : null
}

export const readBundleId = (appPath, run = runTool) => readPlistKey(appPath, 'CFBundleIdentifier', run)
export const readBundleVersion = (appPath, run = runTool) => readPlistKey(appPath, 'CFBundleShortVersionString', run)

/**
 * Parse `codesign -dv --verbose=2` output (it is written to stderr).
 * @param {string} text
 */
export function parseCodesign(text) {
  const field = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? null
  const flags = /flags=0x[0-9a-f]+\(([^)]*)\)/.exec(text)?.[1] ?? null
  const signature = field('Signature')
  return {
    identifier: field('Identifier'),
    signature,
    adhoc: signature === 'adhoc' || /flags=0x[0-9a-f]+\([^)]*adhoc/.test(text),
    teamIdentifier: field('TeamIdentifier'),
    flags,
    format: field('Format')
  }
}

/** Read-only `codesign -dv`; never signs, never verifies against the keychain. */
export function readCodesign(appPath, run = runTool) {
  const result = run('/usr/bin/codesign', ['-dv', '--verbose=2', appPath])
  if (result.status !== 0 && !result.stderr)
    return { error: result.error ?? 'codesign produced no output', adhoc: false }
  return parseCodesign(`${result.stderr}\n${result.stdout}`)
}

/** sha256 of the main executable of a bundle, or null when it cannot be read. */
export function mainExecutableSha256(appPath) {
  try {
    return sha256File(executableForApp(appPath))
  } catch {
    return null
  }
}
