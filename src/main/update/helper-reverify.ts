import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HelperVerdict } from '@shared/update-lifecycle'
import type { PackageRuntimeContract } from '../features/components/speech-pack/package-contract'
import { execFileNoShell } from '../infra/process/exec-file'
import { setHelperTrust } from './helper-quarantine'

export interface CodeIdentityLike {
  teamId: string
  adhoc: boolean
}

export interface HelperReverifyDeps {
  platform: NodeJS.Platform
  arch: string
  resourcesPath: string
  /** The .app bundle path on macOS, or null. */
  appBundlePath: string | null
  contract(): Promise<PackageRuntimeContract>
  fileExists(path: string): boolean
  /** `codesign --verify --strict`: true when the exit code is 0. */
  codesignVerify(path: string): Promise<boolean>
  getCodeIdentity(path: string): Promise<CodeIdentityLike | null>
  /** Hex sha256 of a file, or null when unreadable. */
  sha256File(path: string): Promise<string | null>
  /** Reason codes only; never a path, a team id or a cdhash. */
  log(message: string): void
}

const CODESIGN_TIMEOUT_MS = 10_000

export function codesignVerifyFixedTool(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFileNoShell(
      '/usr/bin/codesign',
      ['--verify', '--strict', path],
      { shell: false, timeout: CODESIGN_TIMEOUT_MS, windowsHide: true },
      (error) => resolve(error === null)
    )
  })
}

export function sha256FileStreaming(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', () => resolve(null))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function macHelpers(deps: HelperReverifyDeps): Array<{ id: string; path: string }> {
  const arch = deps.arch === 'x64' ? 'x64' : 'arm64'
  return [
    { id: 'mac-helper', path: join(deps.resourcesPath, 'mac-helper', 'metis-mac-helper') },
    { id: 'ffmpeg', path: join(deps.resourcesPath, 'ffmpeg', arch, 'ffmpeg') },
    { id: 'managed-node', path: join(deps.resourcesPath, 'managed-node', arch, 'bin', 'node') }
  ]
}

async function verifyMacHelpers(deps: HelperReverifyDeps): Promise<HelperVerdict[]> {
  const verdicts: HelperVerdict[] = []
  const present = macHelpers(deps).filter((h) => {
    const exists = deps.fileExists(h.path)
    if (!exists) verdicts.push({ id: h.id, result: 'skipped', reason: 'absent' })
    return exists
  })
  // Step 1: every helper must pass the OS signature check BEFORE mac-helper is trusted to read identities.
  const signed = new Map<string, boolean>()
  for (const h of present) signed.set(h.id, await deps.codesignVerify(h.path))
  const helperTrusted = signed.get('mac-helper') === true
  let appTeam: string | null = null
  let appSigned = false
  if (helperTrusted && deps.appBundlePath) {
    const app = await deps.getCodeIdentity(deps.appBundlePath)
    if (app && !app.adhoc && app.teamId !== '') {
      appSigned = true
      appTeam = app.teamId
    }
  }
  for (const h of present) {
    if (signed.get(h.id) !== true) {
      verdicts.push({ id: h.id, result: 'fail', reason: 'codesign' })
      continue
    }
    if (!appSigned || !helperTrusted) {
      verdicts.push({ id: h.id, result: 'integrity-only' })
      continue
    }
    const identity = await deps.getCodeIdentity(h.path)
    verdicts.push(
      identity !== null && identity.teamId === appTeam
        ? { id: h.id, result: 'pass' }
        : { id: h.id, result: 'fail', reason: 'team-mismatch' }
    )
  }
  return verdicts
}

async function verifyInventory(deps: HelperReverifyDeps): Promise<HelperVerdict> {
  const contract = await deps.contract()
  if (contract.status !== 'verified') return { id: 'inventory', result: 'skipped-no-inventory' }
  for (const entry of contract.inventory.coreFiles) {
    const actual = await deps.sha256File(join(deps.resourcesPath, entry.path))
    if (actual === null) return { id: 'inventory', result: 'fail', reason: 'missing' }
    if (actual !== entry.sha256) return { id: 'inventory', result: 'fail', reason: 'sha-mismatch' }
  }
  return { id: 'inventory', result: 'pass' }
}

/**
 * Re-check native helpers after an update installed. macOS: signature check, then team-id match against the
 * app when the app is signed (unsigned or ad hoc builds are `integrity-only`). Every platform: the package
 * inventory's core-file hashes. Any failure quarantines helpers (they are not spawned) until a later boot passes.
 */
export async function reverifyHelpers(deps: HelperReverifyDeps): Promise<HelperVerdict[]> {
  const verdicts: HelperVerdict[] = []
  if (deps.platform === 'darwin') verdicts.push(...(await verifyMacHelpers(deps)))
  verdicts.push(await verifyInventory(deps))
  const failed = verdicts.filter((v) => v.result === 'fail')
  setHelperTrust(failed.length > 0 ? 'quarantined' : 'trusted')
  deps.log(
    failed.length > 0
      ? `[updater] helper re-verification failed: ${failed.map((v) => `${v.id}:${v.reason ?? 'fail'}`).join(',')}`
      : '[updater] helper re-verification passed'
  )
  return verdicts
}

export function defaultHelperReverifyDeps(base: {
  platform: NodeJS.Platform
  arch: string
  resourcesPath: string
  appBundlePath: string | null
  contract(): Promise<PackageRuntimeContract>
  getCodeIdentity(path: string): Promise<CodeIdentityLike | null>
  log(message: string): void
}): HelperReverifyDeps {
  return {
    ...base,
    fileExists: existsSync,
    codesignVerify: codesignVerifyFixedTool,
    sha256File: sha256FileStreaming
  }
}
