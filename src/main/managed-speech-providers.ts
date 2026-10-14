import { constants, type Stats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import type { ManagedSpeechProviders } from './speech-broker-policy'

const MAX_POLICY_BYTES = 1_048_576
const MAX_PROVIDER_COUNT = 4_096
const MAX_PROVIDER_ID_LENGTH = 128
const READ_CHUNK_BYTES = 64 * 1024

type FileInspection = { state: 'present'; stat: Stats } | { state: 'missing' } | { state: 'invalid' }
type FileRead = { state: 'present'; bytes: Uint8Array } | { state: 'missing' } | { state: 'invalid' }
type ParsedPolicy = ManagedSpeechProviders | { state: 'key-absent' }

export type ReadTrustedAdminBytes = (path: string) => Uint8Array | null

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null
  return typeof error.code === 'string' ? error.code : null
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

async function inspectRegularFile(path: string): Promise<FileInspection> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink() || !stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0)
      return { state: 'invalid' }
    return { state: 'present', stat }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' }
  }
}

async function readBoundedRegularFile(path: string): Promise<FileRead> {
  const initial = await inspectRegularFile(path)
  if (initial.state !== 'present') return initial
  if (initial.stat.size > MAX_POLICY_BYTES) return { state: 'invalid' }

  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' }
  }

  try {
    const opened = await handle.stat()
    const pathAtOpen = await inspectRegularFile(path)
    if (
      pathAtOpen.state !== 'present' ||
      !sameFileIdentity(initial.stat, opened) ||
      !sameFileIdentity(initial.stat, pathAtOpen.stat) ||
      opened.size > MAX_POLICY_BYTES
    )
      return { state: 'invalid' }

    const buffer = Buffer.alloc(MAX_POLICY_BYTES + 1)
    let total = 0
    while (total <= MAX_POLICY_BYTES) {
      const requested = Math.min(READ_CHUNK_BYTES, MAX_POLICY_BYTES + 1 - total)
      const { bytesRead: count } = await handle.read(buffer, total, requested, null)
      if (count === 0) break
      total += count
    }
    if (total > MAX_POLICY_BYTES) return { state: 'invalid' }

    const after = await handle.stat()
    const pathAfterRead = await inspectRegularFile(path)
    if (
      pathAfterRead.state !== 'present' ||
      !sameFileIdentity(initial.stat, after) ||
      !sameFileIdentity(initial.stat, pathAfterRead.stat) ||
      total !== after.size
    )
      return { state: 'invalid' }

    return { state: 'present', bytes: Buffer.from(buffer.subarray(0, total)) }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' }
  } finally {
    try {
      await handle.close()
    } catch {
      // A close failure cannot make the policy valid; the read result remains fail-closed.
    }
  }
}

function parsePolicyBytes(bytes: Uint8Array): ParsedPolicy {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_POLICY_BYTES) return { state: 'invalid' }
  let value: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(text)
  } catch {
    return { state: 'invalid' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { state: 'invalid' }

  const record = value as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'allowedProviders')) return { state: 'key-absent' }
  const providers = record.allowedProviders
  if (
    !Array.isArray(providers) ||
    providers.length > MAX_PROVIDER_COUNT ||
    providers.some(
      (provider) => typeof provider !== 'string' || provider.length === 0 || provider.length > MAX_PROVIDER_ID_LENGTH
    )
  )
    return { state: 'invalid' }

  return { state: 'valid', providers: [...new Set(providers)] }
}

async function readUserPolicy(path: string): Promise<ManagedSpeechProviders> {
  const read = await readBoundedRegularFile(path)
  if (read.state === 'missing') return { state: 'absent' }
  if (read.state === 'invalid') return { state: 'invalid' }
  const parsed = parsePolicyBytes(read.bytes)
  return parsed.state === 'key-absent' ? { state: 'absent' } : parsed
}

/**
 * Read the provider restriction at a settings/policy boundary. Machine policy wins when its key is
 * present; a trusted machine file without that key falls back to the user policy. Existing but
 * malformed or untrusted policy is a refusal, never an unrestricted fallback.
 */
export function readManagedSpeechProviders(
  userPolicyPath: string,
  adminPolicyPath: string,
  readTrustedAdminBytes: ReadTrustedAdminBytes
): Promise<ManagedSpeechProviders> {
  if (
    typeof userPolicyPath !== 'string' ||
    userPolicyPath.length === 0 ||
    typeof adminPolicyPath !== 'string' ||
    adminPolicyPath.length === 0 ||
    typeof readTrustedAdminBytes !== 'function'
  )
    return Promise.resolve({ state: 'invalid' })

  return readManagedSpeechProvidersAsync(userPolicyPath, adminPolicyPath, readTrustedAdminBytes)
}

async function readManagedSpeechProvidersAsync(
  userPolicyPath: string,
  adminPolicyPath: string,
  readTrustedAdminBytes: ReadTrustedAdminBytes
): Promise<ManagedSpeechProviders> {
  const admin = await inspectRegularFile(adminPolicyPath)
  if (admin.state === 'missing') return readUserPolicy(userPolicyPath)
  if (admin.state === 'invalid' || admin.stat.size > MAX_POLICY_BYTES) return { state: 'invalid' }

  let trustedBytes: Uint8Array | null
  try {
    trustedBytes = readTrustedAdminBytes(adminPolicyPath)
  } catch {
    return { state: 'invalid' }
  }
  if (!(trustedBytes instanceof Uint8Array) || trustedBytes.byteLength > MAX_POLICY_BYTES) return { state: 'invalid' }

  const adminAfterRead = await inspectRegularFile(adminPolicyPath)
  if (
    adminAfterRead.state !== 'present' ||
    !sameFileIdentity(admin.stat, adminAfterRead.stat) ||
    trustedBytes.byteLength !== admin.stat.size
  )
    return { state: 'invalid' }

  const parsedAdmin = parsePolicyBytes(Buffer.from(trustedBytes))
  if (parsedAdmin.state === 'invalid') return { state: 'invalid' }
  if (parsedAdmin.state === 'valid') return parsedAdmin
  return readUserPolicy(userPolicyPath)
}
