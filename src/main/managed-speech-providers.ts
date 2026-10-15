import { constants, type Stats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { normalizeHost } from './net/egress-policy'
import type { ManagedSpeechProviders } from './speech-broker-policy'

const MAX_POLICY_BYTES = 1_048_576
const MAX_PROVIDER_COUNT = 4_096
const MAX_PROVIDER_ID_LENGTH = 128
const MAX_EGRESS_HOST_COUNT = 4_096
const MAX_EGRESS_HOST_LENGTH = 512
const READ_CHUNK_BYTES = 64 * 1024

type FileInspection = { state: 'present'; stat: Stats } | { state: 'missing' } | { state: 'invalid' }
type FileRead = { state: 'present'; bytes: Uint8Array } | { state: 'missing' } | { state: 'invalid' }
type ParsedField<T> = { state: 'absent' } | { state: 'invalid' } | { state: 'value'; value: T }
type ParsedPolicy = {
  providers: ParsedField<string[]>
  egressAllowlist: ParsedField<string[]>
}

export type ManagedSpeechPolicyRead =
  | { state: 'invalid' }
  | { state: 'absent' }
  | {
      state: 'valid'
      providers: Exclude<ManagedSpeechProviders, { state: 'invalid' }>
      /** null only means that neither admin nor user policy configured this key. */
      egressAllowlist: readonly string[] | null
    }

const ABSENT_POLICY: ParsedPolicy = {
  providers: { state: 'absent' },
  egressAllowlist: { state: 'absent' }
}
const INVALID_POLICY: ParsedPolicy = {
  providers: { state: 'invalid' },
  egressAllowlist: { state: 'invalid' }
}

export type ReadTrustedAdminBytes = (path: string) => Uint8Array | null | Promise<Uint8Array | null>

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
  } catch {
    // The first lstat already observed a configured file. Disappearance or replacement after
    // that point is a race and must not turn a restriction into an unrestricted absence.
    return { state: 'invalid' }
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
  } catch {
    return { state: 'invalid' }
  } finally {
    try {
      await handle.close()
    } catch {
      // A close failure cannot make the policy valid; the read result remains fail-closed.
    }
  }
}

function parseStringList(
  record: Record<string, unknown>,
  key: string,
  maxCount: number,
  maxLength: number
): ParsedField<string[]> {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return { state: 'absent' }
  const value = record[key]
  if (
    !Array.isArray(value) ||
    value.length > maxCount ||
    value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > maxLength)
  )
    return { state: 'invalid' }
  return { state: 'value', value: [...new Set(value as string[])] }
}

function parseEgressField(record: Record<string, unknown>): ParsedField<string[]> {
  const raw = parseStringList(record, 'egressAllowlist', MAX_EGRESS_HOST_COUNT, MAX_EGRESS_HOST_LENGTH)
  if (raw.state !== 'value') return raw
  const hosts: string[] = []
  for (const item of raw.value) {
    const host = normalizeHost(item)
    if (!host) return { state: 'invalid' }
    if (!hosts.includes(host)) hosts.push(host)
  }
  return { state: 'value', value: hosts }
}

function parsePolicyBytes(bytes: Uint8Array): ParsedPolicy | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_POLICY_BYTES) return null
  let value: unknown
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const record = value as Record<string, unknown>
  return {
    providers: parseStringList(record, 'allowedProviders', MAX_PROVIDER_COUNT, MAX_PROVIDER_ID_LENGTH),
    egressAllowlist: parseEgressField(record)
  }
}

async function readUserPolicy(path: string): Promise<ParsedPolicy> {
  const read = await readBoundedRegularFile(path)
  if (read.state === 'missing') return ABSENT_POLICY
  if (read.state === 'invalid') return INVALID_POLICY
  return parsePolicyBytes(read.bytes) ?? INVALID_POLICY
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

  return readEffectivePolicy(userPolicyPath, adminPolicyPath, readTrustedAdminBytes).then((result) =>
    providersFromField(result.providers)
  )
}

/** Read both speech provider restrictions and egress hosts from the same bounded, verified policy bytes. */
export function readManagedSpeechPolicy(
  userPolicyPath: string,
  adminPolicyPath: string,
  readTrustedAdminBytes: ReadTrustedAdminBytes
): Promise<ManagedSpeechPolicyRead> {
  if (
    typeof userPolicyPath !== 'string' ||
    userPolicyPath.length === 0 ||
    typeof adminPolicyPath !== 'string' ||
    adminPolicyPath.length === 0 ||
    typeof readTrustedAdminBytes !== 'function'
  )
    return Promise.resolve({ state: 'invalid' })

  return readEffectivePolicy(userPolicyPath, adminPolicyPath, readTrustedAdminBytes).then((result) => {
    if (result.providers.state === 'invalid' || result.egressAllowlist.state === 'invalid') return { state: 'invalid' }
    const providers = providersFromField(result.providers)
    if (providers.state === 'invalid') return { state: 'invalid' }
    if (providers.state === 'absent' && result.egressAllowlist.state === 'absent') return { state: 'absent' }
    return {
      state: 'valid',
      providers,
      egressAllowlist: result.egressAllowlist.state === 'value' ? result.egressAllowlist.value : null
    }
  })
}

function providersFromField(field: ParsedField<string[]>): ManagedSpeechProviders {
  if (field.state === 'invalid') return { state: 'invalid' }
  if (field.state === 'absent') return { state: 'absent' }
  return { state: 'valid', providers: field.value }
}

function resolveField<T>(admin: ParsedField<T>, user: ParsedField<T>): ParsedField<T> {
  return admin.state === 'absent' ? user : admin
}

async function readEffectivePolicy(
  userPolicyPath: string,
  adminPolicyPath: string,
  readTrustedAdminBytes: ReadTrustedAdminBytes
): Promise<ParsedPolicy> {
  const admin = await inspectRegularFile(adminPolicyPath)
  if (admin.state === 'missing') return readUserPolicy(userPolicyPath)
  if (admin.state === 'invalid' || admin.stat.size > MAX_POLICY_BYTES) return INVALID_POLICY

  let trustedBytes: Uint8Array | null
  try {
    trustedBytes = await readTrustedAdminBytes(adminPolicyPath)
  } catch {
    return INVALID_POLICY
  }
  if (!(trustedBytes instanceof Uint8Array) || trustedBytes.byteLength > MAX_POLICY_BYTES) return INVALID_POLICY

  const adminAfterRead = await inspectRegularFile(adminPolicyPath)
  if (
    adminAfterRead.state !== 'present' ||
    !sameFileIdentity(admin.stat, adminAfterRead.stat) ||
    trustedBytes.byteLength !== admin.stat.size
  )
    return INVALID_POLICY

  const parsedAdmin = parsePolicyBytes(Buffer.from(trustedBytes))
  if (!parsedAdmin) return INVALID_POLICY
  const user = await readUserPolicy(userPolicyPath)
  return {
    providers: resolveField(parsedAdmin.providers, user.providers),
    egressAllowlist: resolveField(parsedAdmin.egressAllowlist, user.egressAllowlist)
  }
}
