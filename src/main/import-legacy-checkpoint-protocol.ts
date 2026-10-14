import type { ImportJobHeader, ImportLegacyBounds, ImportLegacyFailure } from './import-legacy-checkpoint-contract'

export type LegacyCodecFormat = 'plain' | 'native-v1-plaintext' | 'v2-scan' | 'v2-decrypt'
export interface LegacyV2Descriptor {
  v: 2
  iv: string
  tag: string
  kLocal: string
  kEscrow?: string
  ciphertextBytes: number
  ciphertextSha256: string
}

export type LegacyInput =
  | { protocol: 1; op: 'open'; sessionId: string; format: LegacyCodecFormat; bounds: ImportLegacyBounds }
  | { protocol: 1; op: 'key'; sessionId: string; descriptor: LegacyV2Descriptor; key: Uint8Array }
  | { protocol: 1; op: 'chunk'; sessionId: string; sequence: number; bytes: Uint8Array }
  | { protocol: 1; op: 'record-ack'; sessionId: string; recordSequence: number }
  | { protocol: 1; op: 'end' | 'cancel'; sessionId: string }

export type LegacyOutput =
  | { protocol: 1; type: 'input-credit'; sessionId: string; nextSequence: number }
  | { protocol: 1; type: 'scan-complete'; sessionId: string; descriptor: LegacyV2Descriptor; sourceDigest: string }
  | { protocol: 1; type: 'record'; sessionId: string; recordSequence: number; recordJson: Uint8Array }
  | {
      protocol: 1
      type: 'complete'
      sessionId: string
      header: ImportJobHeader
      totals: Omit<LegacyReadTotalsWire, 'sourceDigest'>
      sourceDigest: string
    }
  | { protocol: 1; type: 'refused'; sessionId: string; reason: ImportLegacyFailure }

export interface LegacyReadTotalsWire {
  records: number
  words: number
  payloadBytes: number
  decodedBytes: number
  sourceDigest: string
}

const failureCodes: readonly ImportLegacyFailure[] = [
  'UNCONFIGURED',
  'OWNERSHIP_UNPROVEN',
  'STALE_SCOPE',
  'SOURCE_CHANGED',
  'DEADLINE',
  'CLEANUP_FAILED',
  'LIMIT',
  'MALFORMED',
  'KEY_UNAVAILABLE',
  'NATIVE_V1_UNAVAILABLE',
  'WORKER_FAILED'
]

function exact(value: object, keys: string): boolean {
  return Object.keys(value).sort().join(',') === keys
}

export function isLegacyOutput(value: unknown): value is LegacyOutput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (v.protocol !== 1 || typeof v.type !== 'string' || typeof v.sessionId !== 'string') return false
  if (v.type === 'input-credit')
    return (
      exact(v, 'nextSequence,protocol,sessionId,type') &&
      Number.isSafeInteger(v.nextSequence) &&
      (v.nextSequence as number) >= 0
    )
  if (v.type === 'record')
    return (
      exact(v, 'protocol,recordJson,recordSequence,sessionId,type') &&
      Number.isSafeInteger(v.recordSequence) &&
      (v.recordSequence as number) >= 0 &&
      v.recordJson instanceof Uint8Array &&
      v.recordJson.byteOffset === 0 &&
      v.recordJson.byteLength === v.recordJson.buffer.byteLength
    )
  if (v.type === 'scan-complete') {
    const d = v.descriptor as Record<string, unknown> | undefined
    return (
      exact(v, 'descriptor,protocol,sessionId,sourceDigest,type') &&
      /^[a-f0-9]{64}$/.test(String(v.sourceDigest)) &&
      Boolean(
        d &&
          typeof d === 'object' &&
          !Array.isArray(d) &&
          (exact(d, 'ciphertextBytes,ciphertextSha256,iv,kLocal,tag,v') ||
            exact(d, 'ciphertextBytes,ciphertextSha256,iv,kEscrow,kLocal,tag,v')) &&
          d.v === 2 &&
          typeof d.iv === 'string' &&
          typeof d.tag === 'string' &&
          typeof d.kLocal === 'string' &&
          (d.kEscrow === undefined || typeof d.kEscrow === 'string') &&
          Number.isSafeInteger(d.ciphertextBytes) &&
          typeof d.ciphertextSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(d.ciphertextSha256)
      )
    )
  }
  if (v.type === 'complete') {
    const totals = v.totals as Record<string, unknown> | undefined
    return (
      exact(v, 'header,protocol,sessionId,sourceDigest,totals,type') &&
      Boolean(v.header && typeof v.header === 'object') &&
      /^[a-f0-9]{64}$/.test(String(v.sourceDigest)) &&
      Boolean(
        totals &&
          typeof totals === 'object' &&
          exact(totals, 'decodedBytes,payloadBytes,records,words') &&
          Object.values(totals).every((n) => Number.isSafeInteger(n) && (n as number) >= 0)
      )
    )
  }
  if (v.type === 'refused')
    return exact(v, 'protocol,reason,sessionId,type') && failureCodes.includes(v.reason as ImportLegacyFailure)
  return false
}
