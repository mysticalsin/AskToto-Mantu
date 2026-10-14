import { createHash } from 'node:crypto'
import type { RuntimeCatalogV1 } from './runtime-provenance'

const MAX_ROOT_BYTES = 2 * 1024 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function parse(bytes: Uint8Array, maxBytes: number, code: string): Record<string, unknown> {
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) throw new Error(code)
  try {
    const value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
    if (!value) throw new Error(code)
    return value
  } catch {
    throw new Error(code)
  }
}

/** Validate the app-owned TUF acquisition receipt and exact pinned root before the app accepts a catalog. */
export function verifyPinnedRuntimeTrust(
  pin: NonNullable<RuntimeCatalogV1['trustRoot']>,
  rootBytes: Uint8Array,
  receiptBytes: Uint8Array
): Record<string, unknown> {
  if (rootBytes.byteLength !== pin.bytes || rootBytes.byteLength > MAX_ROOT_BYTES || sha256(rootBytes) !== pin.sha256) {
    throw new Error('RUNTIME_TRUST_ROOT_PIN_MISMATCH')
  }
  if (
    receiptBytes.byteLength !== pin.receipt.bytes ||
    receiptBytes.byteLength > MAX_RECEIPT_BYTES ||
    sha256(receiptBytes) !== pin.receipt.sha256
  ) {
    throw new Error('RUNTIME_TRUST_ROOT_RECEIPT_PIN_MISMATCH')
  }
  const receipt = parse(receiptBytes, MAX_RECEIPT_BYTES, 'RUNTIME_TRUST_ROOT_RECEIPT_INVALID')
  const verifiedBy = record(receipt.verifiedBy)
  if (
    !exactKeys(receipt, [
      'schemaVersion',
      'source',
      'verifiedBy',
      'sourceCommit',
      'workflowRef',
      'workflowCommit',
      'runId',
      'attempt',
      'lockSha256',
      'rootBytes',
      'rootSha256'
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.source !== pin.source ||
    !verifiedBy ||
    !exactKeys(verifiedBy, ['package', 'version']) ||
    verifiedBy.package !== '@sigstore/tuf' ||
    verifiedBy.version !== '5.0.0' ||
    typeof receipt.sourceCommit !== 'string' ||
    !COMMIT.test(receipt.sourceCommit) ||
    typeof receipt.workflowCommit !== 'string' ||
    !COMMIT.test(receipt.workflowCommit) ||
    typeof receipt.workflowRef !== 'string' ||
    !/^mysticalsin\/AskToto-Mantu\/\.github\/workflows\/runtime-trust-root\.yml@refs\/heads\/[A-Za-z0-9._/-]{1,256}$/.test(
      receipt.workflowRef
    ) ||
    typeof receipt.runId !== 'string' ||
    !/^\d{1,20}$/.test(receipt.runId) ||
    !Number.isSafeInteger(receipt.attempt) ||
    (receipt.attempt as number) < 1 ||
    typeof receipt.lockSha256 !== 'string' ||
    !SHA256.test(receipt.lockSha256) ||
    receipt.rootBytes !== pin.bytes ||
    receipt.rootSha256 !== pin.sha256
  ) {
    throw new Error('RUNTIME_TRUST_ROOT_RECEIPT_INVALID')
  }
  return parse(rootBytes, MAX_ROOT_BYTES, 'RUNTIME_TRUST_ROOT_UNAVAILABLE')
}
